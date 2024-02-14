import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import pg from 'pg';
import { json, tags, type IValidation } from 'typia';

const {Client} = pg;

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

const client = new Client({
  connectionString: process.env.DATABASE_URL ?? 'postgres://postgres:hbZkzny5xrvVH@localhost:5432/dev',
  statement_timeout: 0,
  query_timeout: 0,
  connectionTimeoutMillis: 0,
  keepAlive: true,
});

client.connect();

client.on('error', (error) => {
  console.error(error);
});

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

    const args = [id, parsed.data.tipo, parsed.data.valor, parsed.data.descricao];
    client.query(`CALL SALVAR_TRANSACAO($1, $2, $3, $4, '0'::varchar);`, args, (error: any, result) => {
      if (error) {
        if (error.constraint === 'pessoas_check') {
          return unprocessableEntityHandler(res);
        }

        console.error('Error calling procedure', error);
        return unexpectedError(res);
      }

      if (result.rowCount === 0) {
        console.error('Error zero rows updated');
        return unexpectedError(res);
      }

      if (result.rows[0].resultado === '-1') {
        return notFoundHandler(res);
      }

      const [balance, limit] = result.rows[0].resultado.split(':');

      res.writeHead(200, defaultJsonHeaders);
      res.end(transactionStringify({saldo: +balance, limite: +limit}));
    });
  });
};

const extractHandler = (id: number, req: IncomingMessage, res: ServerResponse) => {
  if (req.method !== 'GET') {
    return notFoundHandler(res);
  }

  client.query(`SELECT id, limite, saldo FROM pessoas WHERE id = $1;`, [id], (error, result) => {
    if (error) {
      console.error('Error selecting data', error);
      return unexpectedError(res);
    }

    if (result.rowCount === 0) {
      return notFoundHandler(res);
    }

    const data = result.rows[0];

    client.query(`SELECT valor, tipo, descricao, realizada_em FROM transacoes WHERE pessoa_id = $1 ORDER BY realizada_em DESC LIMIT 10;`, [id], (err2, transactions) => {
      if (err2) {
        console.error('Error selecting data of transactions', err2);
        return unexpectedError(res);
      }

      res.writeHead(200, defaultJsonHeaders);
      res.end(excerptStringify({
        saldo: {
          limite: data.limite,
          total: data.saldo,
          data_extrato: new Date(),
        },
        ultimas_transacoes: transactions.rows,
      }));
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
server.listen(3000, 5_000);

console.log('Server running at http://localhost:3000/');
