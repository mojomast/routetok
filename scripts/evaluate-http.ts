import {readFileSync} from 'node:fs';import {evaluate} from '../src/evaluation-runner.js';
const config=JSON.parse(readFileSync(process.argv[2],'utf8'));config.key=process.env.BENCH_API_KEY;console.log(JSON.stringify(await evaluate(config),null,2));
