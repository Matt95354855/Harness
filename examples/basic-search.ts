import { createDemoAgent } from '../src/index.js';
const agent = createDemoAgent();
console.log(await agent.process('Quels sont les composants d’un harness IA ?'));
console.log('\nTrace :', agent.getTrace()?.status);
