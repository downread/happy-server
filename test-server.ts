#!/usr/bin/env ts-node
import express from 'express';
import { initHappyServer } from './index';

const app = express();

initHappyServer(app);

app.get('/', (req, res) => {
  res.send('Hello, world!');
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Test server running on http://localhost:${port}`);
});
