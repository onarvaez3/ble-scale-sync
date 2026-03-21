import type { ScaleAdapter } from '../interfaces/scale-adapter.js';
import { EsCs20mAdapter } from './es-cs20m.js';

export const adapters: ScaleAdapter[] = [new EsCs20mAdapter()];
