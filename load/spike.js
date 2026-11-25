import { journey, thresholds } from './journey.js';
export { setup, teardown } from './journey.js';
export const options = { stages: [{ duration: '30s', target: 5 }, { duration: '10s', target: 25 }, { duration: '1m', target: 25 }, { duration: '20s', target: 0 }], maxRedirects: 0, thresholds };
export default journey;
