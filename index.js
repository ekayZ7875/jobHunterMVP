import express from 'express';
import errorHandler from './utils/errorHandler.js';
import morgan from 'morgan'
import dotenv from 'dotenv'
dotenv.config()

const app = express();
app.use(express.json());
app.use(morgan('dev'))




app.use(errorHandler);




const port = 8080
app.listen(port, () => {
  console.log(`Job Hunter API listening on http://localhost:${port}`);
});
