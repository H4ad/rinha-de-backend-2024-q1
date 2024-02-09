import {Redis} from 'ioredis';
import {createServer, IncomingMessage, ServerResponse} from 'node:http';
import {type IValidation, json, tags} from 'typia';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379/0';
const redis = new Redis(redisUrl);

const defaultJsonHeaders = {
  'Content-Type': 'application/json',
};

const currentDir = fileURLToPath(import.meta.url) + './..';

const storeTransactionLua = readFileSync(join(currentDir, './commands/store-transaction.lua'), 'utf8');
const getTransactionsLua = readFileSync(join(currentDir, './commands/get-transactions.lua'), 'utf8');
const seedLua = readFileSync(join(currentDir, './commands/seed-data.lua'), 'utf8');

redis.defineCommand('storetransaction', {
  lua: storeTransactionLua,
  numberOfKeys: 1,
});

redis.defineCommand('gettransactions', {
  lua: getTransactionsLua,
  numberOfKeys: 1,
});

redis.defineCommand('seeddata', {
  lua: seedLua,
  numberOfKeys: 0,
});

type Transaction = {
  valor: number & tags.Minimum<0> & tags.Type<'uint32'>;
  tipo: 'c' | 'd';
  descricao: string & tags.MaxLength<10> & tags.MinLength<1>;
};

type TransactionResult = {
  limite: number;
  saldo: number;
}

type Excerpt = {
  saldo: {
    total: number;
    data_extrato: Date;
    limite: number;
  }

  ultimas_transacoes: { valor: number, tipo: 'c' | 'd', descricao: string, realizada_em: Date }[];
}

const transactionParse = json.createValidateParse<Transaction>();
const transactionStringify = json.createStringify<TransactionResult>();
const excerptStringify = json.createStringify<Excerpt>();
const stringifyTypiaErrors = json.createStringify<{ errors: IValidation.IError[] }>();

const waitPayload = (req: IncomingMessage, callback: (data: string | null) => void) => {
  let body: null | string = null;

  req.setEncoding('utf8');
  req.on('readable', () => {
    const value = req.read();

    if (!value) {
      return;
    }

    body ??= '';
    body += value;
  });

  req.on('end', () => {
    callback(body);
  });
};

const notFoundHandler = (res: ServerResponse) => {
  res.statusCode = 404;
  res.end();
};

const unprocessableEntityHandler = (res: ServerResponse) => {
  res.statusCode = 422;
  res.end();
};

const unexpectedError = (res: ServerResponse) => {
  res.statusCode = 500;
  res.end();
};

const transactionHandler = (id: number, req: IncomingMessage, res: ServerResponse) => {
  if (req.method !== 'POST') {
    return notFoundHandler(res);
  }

  waitPayload(req, body => {
    if (!body) {
      return unprocessableEntityHandler(res);
    }

    const parsed = transactionParse(body);

    if (!parsed.success) {
      res.writeHead(422, defaultJsonHeaders);
      res.end(stringifyTypiaErrors({errors: parsed.errors}));
      return;
    }

    const description = encodeURIComponent(parsed.data.descricao);

    // @ts-ignore
    redis['storetransaction'](id, parsed.data.tipo, parsed.data.valor, description, Date.now(), (error, data) => {
      if (error) {
        return unexpectedError(res);
      }

      if (data === -1) {
        return notFoundHandler(res);
      }

      if (data === -2) {
        return unprocessableEntityHandler(res);
      }

      const result = transactionStringify({
        limite: data[0],
        saldo: data[1],
      });

      res.writeHead(200, defaultJsonHeaders);
      res.end(result);
    });
  });
};

const extractHandler = (id: number, req: IncomingMessage, res: ServerResponse) => {
  if (req.method !== 'GET') {
    return notFoundHandler(res);
  }

  // @ts-ignore
  redis['gettransactions'](id, (error, data) => {
    if (error) {
      return unexpectedError(res);
    }

    if (data === -1) {
      return notFoundHandler(res);
    }

    if (data === -2) {
      return unprocessableEntityHandler(res);
    }

    const transactions: Excerpt['ultimas_transacoes'] = (data[2] || []).map((transactionLog: string) => {
      const [type, value, description, timestamp] = transactionLog.split(':');

      return {
        tipo: type,
        valor: +value,
        descricao: description,
        realizada_em: new Date(+timestamp)
      };
    });

    const result = excerptStringify({
      saldo: {
        limite: data[0],
        total: data[1],
        data_extrato: new Date(),
      },
      ultimas_transacoes: transactions,
    });

    res.writeHead(200, defaultJsonHeaders);
    res.end(result);
  });
}

const server = createServer((req, res) => {
  if (!req.url) {
    return notFoundHandler(res);
  }

  if (req.url === '/health') {
    // @ts-ignore
    redis['seeddata']((error) => {
      if (error) {
        console.error('Error seeding data', error);
      }

      res.writeHead(error ? 500 : 204, defaultJsonHeaders);
      res.end();
    });
    return;
  }

  const [_, client, id, action] = req.url?.split('/');

  if (client !== 'clientes') {
    return notFoundHandler(res);
  }

  const idInt = +id;

  if (Number.isNaN(idInt)) {
    return notFoundHandler(res);
  }

  switch (action) {
    case 'transacoes': {
      return transactionHandler(idInt, req, res);
    }

    case 'extrato': {
      return extractHandler(idInt, req, res);
    }

    default:
      return notFoundHandler(res);
  }
});

server.keepAliveTimeout = (60 * 1000) + 1000;
server.headersTimeout = 12 * 1000;
server.maxRequestsPerSocket = 0;
server.listen(3000);

console.log('Server running at http://localhost:3000/');
