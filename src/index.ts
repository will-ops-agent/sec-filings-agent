import { app } from './lib/agent';

const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;

console.log(`Starting agent server on port ${port}...`);

// Debug wrapper to log requests
const debugFetch = async (request: Request): Promise<Response> => {
  const url = new URL(request.url);
  const paymentHeader = request.headers.get('PAYMENT-SIGNATURE') || request.headers.get('X-PAYMENT') || request.headers.get('PAYMENT');
  
  console.log(`[REQ] ${request.method} ${url.pathname}`);
  if (paymentHeader) {
    console.log(`[REQ] Payment header present (${paymentHeader.length} chars)`);
  }
  
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
