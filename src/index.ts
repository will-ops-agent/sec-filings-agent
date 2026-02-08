import { app } from './lib/agent';

const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;

console.log(`Starting agent server on port ${port}...`);

// Debug wrapper to log requests
const debugFetch = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  
  console.log(`[REQ] ${request.method} ${url.pathname}`);
  
  // Log ALL headers
  const allHeaders: string[] = [];
  request.headers.forEach((value, key) => {
    allHeaders.push(`${key}: ${value.slice(0, 50)}${value.length > 50 ? '...' : ''}`);
  });
  console.log(`[REQ] Headers: ${allHeaders.join(', ')}`);
  
  const response = await app.fetch(request);
  
  console.log(`[RES] ${response.status} ${url.pathname}`);
  if (response.status === 402) {
    const paymentRequired = response.headers.get('PAYMENT-REQUIRED');
    if (paymentRequired) {
      console.log(`[RES] Payment-Required header present`);
    }
  }
  
  return response;
};

export default {
  port,
  fetch: debugFetch,
};
