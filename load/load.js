import { journey, thresholds } from './journey.js';
export { setup, teardown } from './journey.js';
export const options = { vus: 5, duration: '5m', maxRedirects: 0, thresholds };
export default journey;
