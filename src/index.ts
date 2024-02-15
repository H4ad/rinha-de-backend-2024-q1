import {createServer, IncomingMessage, ServerResponse} from 'node:http';
import postgres from 'postgres';
import {type IValidation, json, tags} from 'typia';
import {Redis} from 'ioredis';

const defaultJsonHeaders = {
  'Content-Type': 'application/json',
};

type Transaction = {
  valor: number & tags.Minimum<0> & tags.Type<'uint32'>;
  tipo: 'c' | 'd';
  descricao: string & tags.MaxLength<10> & tags.MinLength<1>;
};

type TransactionResult = {
  limite: number;
  saldo: number;
}

type ExcerptTransaction = { valor: number, tipo: 'c' | 'd', descricao: string, realizada_em: Date };

type Excerpt = {
  saldo: {
    total: number;
    data_extrato: string;
    limite: number;
  }

  ultimas_transacoes: ExcerptTransaction[];
}

type CachedExcerpt = Omit<Excerpt, 'ultimas_transacoes'> & {
  ultimas_transacoes: Array<Omit<ExcerptTransaction, 'realizada_em'> & { realizada_em: string }>;
}

const transactionParse = json.createValidateParse<Transaction>();
const transactionStringify = json.createStringify<TransactionResult>();
const excerptStringify = json.createStringify<Excerpt>();
const cachedExcerptParse = json.createValidateParse<CachedExcerpt>();
const stringifyTypiaErrors = json.createStringify<{ errors: IValidation.IError[] }>();

const sql = postgres(process.env.DATABASE_URL ?? 'postgres://rinha:password@localhost:5432/dev', {
  max: 20,
});
const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379/0');

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

  waitPayload(req, async body => {
    if (!body) {
      return unprocessableEntityHandler(res);
    }

    const parsed = transactionParse(body);

    if (!parsed.success) {
      res.writeHead(422, defaultJsonHeaders);
      res.end(stringifyTypiaErrors({errors: parsed.errors}));
      return;
    }

    sql<{ resultado: string }[]>`CALL SALVAR_TRANSACAO(${id}, ${parsed.data.tipo}, ${parsed.data.valor}, ${parsed.data.descricao}, '0'::varchar);`.then((result) => {
      if (result.length === 0) {
        console.error('Error zero rows updated');
        return unexpectedError(res);
      }

      if (result[0].resultado === '-1') {
        return notFoundHandler(res);
      }

      redis.hdel(`person:${id}`, 'extract');

      const [balance, limit] = result[0].resultado.split(':');

      const jsonResult = transactionStringify({saldo: +balance, limite: +limit});

      res.writeHead(200, {...defaultJsonHeaders, 'content-length': Buffer.byteLength(jsonResult) });
      res.end(jsonResult);
    }).catch(error => {
      if (error.constraint_name === 'pessoas_check') {
        return unprocessableEntityHandler(res);
      }

      console.error('Error calling procedure', error);
      return unexpectedError(res);
    });
  });
};

const extractHandler = (id: number, req: IncomingMessage, res: ServerResponse) => {
  if (req.method !== 'GET') {
    return notFoundHandler(res);
  }

  redis.hget(`person:${id}`, 'extract', (error, cachedData) => {
    if (error) {
      console.error('Error getting data from cache', error);
      return unexpectedError(res);
    }

    if (cachedData) {
      const oldExcerpt = cachedExcerptParse(cachedData);

      if (!oldExcerpt.success) {
        console.error('Error parsing cached data', oldExcerpt.errors);
        return unexpectedError(res);
      }

      const jsonResult = excerptStringify({
        saldo: {
          total: oldExcerpt.data.saldo.total,
          data_extrato: new Date().toISOString(),
          limite: oldExcerpt.data.saldo.limite,
        },
        ultimas_transacoes: oldExcerpt.data.ultimas_transacoes.map((transaction: any) => ({
          ...transaction,
          realizada_em: new Date(transaction.realizada_em),
        })),
      });

      res.writeHead(200, {...defaultJsonHeaders, 'content-length': Buffer.byteLength(jsonResult)});
      res.end(jsonResult);
      return;
    }

    Promise.allSettled([
      sql<{ id: number, limite: number, saldo: number }[]>`SELECT id, limite, saldo FROM pessoas WHERE id = ${id};`,
      sql<Excerpt['ultimas_transacoes']>`SELECT valor, tipo, descricao, realizada_em FROM transacoes WHERE pessoa_id = ${id} ORDER BY realizada_em DESC LIMIT 10;`,
    ]).then(([person, transactions]) => {
      if (person.status === 'rejected') {
        console.error('Error selecting data', person.reason);
        return unexpectedError(res);
      }

      if (person.value.length === 0) {
        return notFoundHandler(res);
      }

      if (transactions.status === 'rejected') {
        console.error('Error selecting data of transactions', transactions.reason);
        return unexpectedError(res);
      }

      const excerpt = excerptStringify({
        saldo: {
          limite: person.value[0].limite,
          total: person.value[0].saldo,
          data_extrato: new Date().toISOString(),
        },
        ultimas_transacoes: transactions.value,
      });

      redis.hset(`person:${id}`, 'extract', excerpt);

      res.writeHead(200, {...defaultJsonHeaders, 'content-length': Buffer.byteLength(excerpt)});
      res.end(excerpt);
    });
  });
}

const server = createServer((req, res) => {
  if (!req.url) {
    return notFoundHandler(res);
  }

  if (req.url === '/health') {
    res.writeHead(204, defaultJsonHeaders);
    res.end();
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

server.keepAliveTimeout = 60 * 1000;
server.headersTimeout = 60 * 1000;
server.maxRequestsPerSocket = 0;
server.listen(3000, 20_000);

console.log('Server running at http://localhost:3000/');
