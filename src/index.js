import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { ready } from './db.js';
import { advisorsRouter } from './routes/advisors.js';
import { ticketsRouter } from './routes/tickets.js';
import { customersRouter } from './routes/customers.js';
import { reportsRouter } from './routes/reports.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.join(__dirname, 'public');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: '*' },
});

app.use(cors());
app.use(express.json());

app.locals.emitChanged = () => io.emit('queue:changed');

app.use('/api/advisors', advisorsRouter);
app.use('/api/tickets', ticketsRouter);
app.use('/api/customers', customersRouter);
app.use('/api/reports', reportsRouter);

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use(express.static(clientDist));
app.get('/', (req, res) => res.sendFile(path.join(clientDist, 'index.html')));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'Lỗi máy chủ' });
});

io.on('connection', (socket) => {
  socket.emit('queue:changed');
});

const PORT = process.env.PORT || 4000;

ready
  .then(() => {
    httpServer.listen(PORT, () => {
      console.log(`Showroom queue server running on http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Không thể khởi tạo database:', err);
    process.exit(1);
  });
