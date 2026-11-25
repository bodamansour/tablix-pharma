import { journey, thresholds } from './journey.js';
export { setup, teardown } from './journey.js';
export const options = { vus: 2, duration: '1m', maxRedirects: 0, thresholds };
export default journey;
