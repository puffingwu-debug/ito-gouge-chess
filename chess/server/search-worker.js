import { parentPort, workerData } from 'node:worker_threads';
import { rankMoves } from '../core/xiangqi.js';
const { board, color, difficulty, options } = workerData;
parentPort.postMessage(rankMoves(board, color, difficulty, options));
