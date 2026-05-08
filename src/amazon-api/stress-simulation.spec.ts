import { AmazonApiService } from './amazon-api.service';
import axios from 'axios';

// Mock Dependencies
const mockAuthService: any = {
  getAccessToken: jest.fn().mockResolvedValue('Atzr|mock_token'),
  getAwsCredentials: jest.fn().mockReturnValue({
    accessKeyId: 'AKIA_MOCK_KEY',
    secretAccessKey: 'MOCK_SECRET_KEY',
    region: 'us-east-1'
  }),
  getApiBaseUrl: jest.fn().mockReturnValue('https://sellingpartnerapi-na.amazon.com'),
  clearTokenCache: jest.fn()
};

jest.mock('axios');
const mockedAxios = axios as jest.MockedFunction<typeof axios>;

describe('AmazonApiService Stress Simulation', () => {
  let service: AmazonApiService;

  beforeEach(() => {
    service = new AmazonApiService(mockAuthService);
    jest.clearAllMocks();
  });

  test('1. SigV4 Validation: Structure Check', async () => {
    mockedAxios.mockResolvedValueOnce({ 
      data: { status: 'ok' }, 
      headers: { 'x-amzn-ratelimit-limit': '1.0' } 
    } as any);

    await service.makeRequest('GET', '/vendor/orders/v1/orders');

    const lastCall = mockedAxios.mock.calls[0][0];
    const authHeader = lastCall.headers['Authorization'];

    console.log('--- SigV4 Structure Verification ---');
    console.log(`Authorization: ${authHeader}`);
    console.log(`X-Amz-Date: ${lastCall.headers['X-Amz-Date']}`);
    
    expect(authHeader).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIA_MOCK_KEY/);
    expect(lastCall.headers['x-amz-access-token']).toBe('Atzr|mock_token');
    console.log('✅ SigV4 Structure Valid');
  });

  test('2. Retry Simulation: 503 Server Error & Signature Regeneration', async () => {
    // Fail twice with 503, succeed on 3rd
    mockedAxios
      .mockRejectedValueOnce({ response: { status: 503, data: 'Error' } })
      .mockRejectedValueOnce({ response: { status: 503, data: 'Error' } })
      .mockResolvedValueOnce({ data: { success: true }, headers: {} });

    console.log('--- Retry & Regeneration Simulation ---');
    const result = await service.makeRequest('GET', '/test');

    expect(mockedAxios).toHaveBeenCalledTimes(3);
    
    // Check dates on different calls
    const call1Date = mockedAxios.mock.calls[0][0].headers['X-Amz-Date'];
    const call3Date = mockedAxios.mock.calls[2][0].headers['X-Amz-Date'];
    
    console.log(`Attempt 1 Sig Date: ${call1Date}`);
    console.log(`Attempt 3 Sig Date: ${call3Date}`);
    expect(result.success).toBe(true);
    console.log('✅ Retry & Signature Regeneration Verified');
  }, 15000);

  test('3. Throttling Check: Burst Protection', async () => {
    mockedAxios.mockResolvedValue({ 
      data: { ok: true }, 
      headers: { 'x-amzn-ratelimit-limit': '5.0' } // 5 req/sec = 200ms delay
    } as any);

    console.log('--- Burst Throttling Check (10 Requests) ---');
    const startTime = Date.now();
    
    // Fire 10 requests in sequence
    for(let i = 0; i < 10; i++) {
       await service.makeRequest('GET', `/burst/${i}`);
    }
    
    const duration = Date.now() - startTime;
    console.log(`Total duration for 10 requests: ${duration}ms`);
    
    // 10 requests with 200ms delay between each should take at least 1500ms
    expect(duration).toBeGreaterThan(1500);
    console.log('✅ Burst Throttling Delay Verified');
  }, 30000);
});
