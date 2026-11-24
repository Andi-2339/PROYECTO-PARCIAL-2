const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');
const net = require('net');
const { trace, metrics } = require('@opentelemetry/api');
const { logs, SeverityNumber } = require('@opentelemetry/api-logs');

const app = express();
const PORT = process.env.PORT || 80;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'ConsultaWeb')));

// --- Observabilidad OpenTelemetry (RF-04): Métricas, Logs y Trazas ---
const tracer = trace.getTracer('practica-devops-api');
const meter = metrics.getMeter('practica-devops-api');
const logger = logs.getLogger('practica-devops-api');

const httpRequestsCounter = meter.createCounter('http_requests_total', {
  description: 'Total de peticiones HTTP por endpoint',
});
const httpErrorsCounter = meter.createCounter('http_request_errors_total', {
  description: 'Total de errores HTTP (4xx y 5xx) por endpoint',
});
const httpDurationHistogram = meter.createHistogram('http_request_duration_ms', {
  description: 'Latencia de peticiones HTTP en milisegundos',
  unit: 'ms',
});

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    const route = req.route ? req.route.path : req.path;
    const statusCode = res.statusCode;
    const timestamp = new Date().toISOString();
    const attrs = { method: req.method, endpoint: route, statusCode };

    httpRequestsCounter.add(1, attrs);
    httpDurationHistogram.record(duration, attrs);
    if (statusCode >= 400) {
      httpErrorsCounter.add(1, attrs);
    }

    logger.emit({
      severityNumber:
        statusCode >= 500
          ? SeverityNumber.ERROR
          : statusCode >= 400
          ? SeverityNumber.WARN
          : SeverityNumber.INFO,
      severityText: statusCode >= 500 ? 'ERROR' : statusCode >= 400 ? 'WARN' : 'INFO',
      body: `${req.method} ${route} -> ${statusCode} (${duration}ms)`,
      attributes: { ...attrs, duration_ms: duration, timestamp },
    });
  });
  next();
});

// 1. Configuración de BD SQLite con trazas distribuidas
const db = new sqlite3.Database('./database.sqlite');

['all', 'get', 'run'].forEach((method) => {
  const original = db[method].bind(db);
  db[method] = function (sql, ...args) {
    const span = tracer.startSpan(`sqlite.${method}`, {
      attributes: { 'db.system': 'sqlite', 'db.statement': sql },
    });
    const last = args[args.length - 1];
    if (typeof last === 'function') {
      args[args.length - 1] = function (err, ...cbArgs) {
        if (err) span.recordException(err);
        span.end();
        return last.call(this, err, ...cbArgs);
      };
    } else {
      span.end();
    }
    return original(sql, ...args);
  };
});

db.serialize(() => {
  db.run('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, email TEXT)');
});

// Helper para normalizar el JSON Schema solicitado
const responseSchema = (data) => ({ statusCode: 200, data: data });

// Endpoints GET
// 2. Endpoint: Estado del servidor
app.get('/api/', (req, res) => res.json(responseSchema('prueba Pipeline funciona perfecto')));

// 3. Endpoint: Listar usuarios
app.get('/api/users', (req, res) => {
  db.all('SELECT * FROM users', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(responseSchema(rows));
  });
});

// 4. Endpoint: Obtener usuario por ID
app.get('/api/users/:id', (req, res) => {
  db.get('SELECT * FROM users WHERE id = ?', [req.params.id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json(responseSchema({ error: 'Usuario no encontrado' }));
    res.json(responseSchema(row));
  });
});

// 5. Endpoint: Healthcheck
app.get('/api/health', (req, res) => res.json(responseSchema({ status: 'Prueba 5 con healthy uteq' })));

// Endpoints POST
// 6. Endpoint: Crear usuario
app.post('/api/users', (req, res) => {
  const { name, email } = req.body;
  if (!name || !email) {
    return res.status(400).json(responseSchema({ error: 'Error de usuario: Faltan campos obligatorios (name, email)' }));
  }
  if (!email.includes('@')) {
    return res.status(400).json(responseSchema({ error: 'Error de usuario: Formato de email inválido' }));
  }

  db.run('INSERT INTO users (name, email) VALUES (?, ?)', [name, email], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.status(201).json(responseSchema({ id: this.lastID, name, email }));
  });
});

// 7. Endpoint: Eco de datos
app.post('/api/echo', (req, res) => {
  if (!req.body || Object.keys(req.body).length === 0) {
    return res.status(400).json(responseSchema({ error: 'Error de usuario: El body no puede estar vacío' }));
  }
  res.json(responseSchema(req.body));
});

// 8. Endpoint: Hacer backup de la BD
app.post('/api/backup', (req, res) => {
  fs.copyFile('./database.sqlite', './backup.sqlite', (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(responseSchema('Backup creado exitosamente como backup.sqlite'));
  });
});

// Endpoints PUT
// Endpoint: Actualizar usuario por ID
app.put('/api/users/:id', (req, res) => {
  const { name, email } = req.body;
  if (!name || !email) {
    return res.status(400).json(responseSchema({ error: 'Error de usuario: Faltan datos para actualizar' }));
  }

  db.run('UPDATE users SET name = ?, email = ? WHERE id = ?', [name, email, req.params.id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes === 0) return res.status(404).json(responseSchema({ error: 'Usuario a actualizar no encontrado' }));
    res.json(responseSchema({ id: req.params.id, name, email }));
  });
});

// Endpoints DELETE
// 9. Endpoint: Eliminar usuario por ID
app.delete('/api/users/:id', (req, res) => {
  db.run('DELETE FROM users WHERE id = ?', [req.params.id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes === 0) return res.status(404).json(responseSchema({ error: 'Usuario a eliminar no encontrado' }));
    res.json(responseSchema(`Usuario ${req.params.id} eliminado`));
  });
});

// 10. Endpoint: Vaciar la BD
app.delete('/api/empty', (req, res) => {
  db.run('DELETE FROM users', (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(responseSchema('Base de datos vaciada por completo'));
  });
});

// Captura global de excepciones para Logs y Trazas (RF-04)
app.use((err, req, res, next) => {
  const activeSpan = trace.getActiveSpan();
  if (activeSpan) activeSpan.recordException(err);

  logger.emit({
    severityNumber: SeverityNumber.ERROR,
    severityText: 'ERROR',
    body: `Excepción en ${req.method} ${req.path}: ${err.message}`,
    attributes: {
      method: req.method,
      endpoint: req.path,
      statusCode: 500,
      timestamp: new Date().toISOString(),
      error_stack: err.stack,
    },
  });

  res.status(500).json({ statusCode: 500, data: { error: err.message } });
});

const TCP_PORT = 6061;

const tcpServer = net.createServer((socket) => {
  socket.on('data', (data) => {
    const message = data.toString().trim();

    if (message.startsWith('{insert:') && message.endsWith('}')) {
      const jsonStr = message.slice(8, -1);
      try {
        const { name, email } = JSON.parse(jsonStr);
        db.run('INSERT INTO users (name, email) VALUES (?, ?)', [name, email], function (err) {
          if (err) socket.write(`Error: ${err.message}\n`);
          else socket.write(`{statusCode: 200, data: {id: ${this.lastID}, name: "${name}", email: "${email}"}}\n`);
        });
      } catch (e) {
        socket.write("{statusCode: 400, data: 'JSON Invalido'}\n");
      }
    } else if (message.startsWith('{get:') && message.endsWith('}')) {
      const id = message.slice(5, -1);
      db.get('SELECT * FROM users WHERE id = ?', [id], (err, row) => {
        if (err) socket.write(`Error: ${err.message}\n`);
        else socket.write(`{statusCode: 200, data: ${JSON.stringify(row || {})}}\n`);
      });
    } else {
      socket.write('Comando TCP no reconocido\n');
    }
  });
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`Servidor escuchando en el puerto ${PORT}`));
  tcpServer.listen(TCP_PORT, () => console.log(`Servidor TCP escuchando en puerto ${TCP_PORT}`));
}

module.exports = app;