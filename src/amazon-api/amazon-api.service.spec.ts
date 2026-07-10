import { Test, TestingModule } from '@nestjs/testing';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { ConfigService } from '@nestjs/config';
import { AuthService } from '../auth/auth.service';
import { AmazonApiService } from './amazon-api.service';
import axios from 'axios';

jest.mock('axios');

describe('AmazonApiService', () => {
  let service: AmazonApiService;
  let configGet: jest.Mock;

  beforeEach(async () => {
    configGet = jest.fn((key: string) => {
      if (key === 'USE_SIGV4') return 'false';
      if (key === 'AMAZON_API_MAX_RETRIES') return '2';
      if (key === 'AMAZON_API_TIMEOUT_SECONDS') return '1';
      return undefined;
    });
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AmazonApiService,
        {
          provide: AuthService,
          useValue: {
            getAccessToken: jest.fn().mockResolvedValue('test-token'),
            getAwsCredentials: jest.fn(() => ({})),
            getApiBaseUrl: jest.fn(() => 'https://example.test'),
            clearTokenCache: jest.fn(),
          },
        },
        { provide: ConfigService, useValue: { get: configGet } },
        {
          provide: CACHE_MANAGER,
          useValue: { get: jest.fn(), set: jest.fn(), del: jest.fn() },
        },
      ],
    }).compile();

    service = module.get<AmazonApiService>(AmazonApiService);
    jest.spyOn(service as any, 'delay').mockResolvedValue(undefined);
    (axios as unknown as jest.Mock).mockReset();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('retries a transient 503 and succeeds', async () => {
    (axios as unknown as jest.Mock)
      .mockRejectedValueOnce({
        message: 'temporarily unavailable',
        response: {
          status: 503,
          headers: { 'x-amzn-requestid': 'request-123' },
        },
      })
      .mockResolvedValueOnce({ status: 200, headers: {}, data: { ok: true } });

    await expect(service.makeRequest('GET', '/test')).resolves.toEqual({
      ok: true,
    });
    expect(axios).toHaveBeenCalledTimes(2);
  });

  it('retries a connection timeout', async () => {
    (axios as unknown as jest.Mock)
      .mockRejectedValueOnce({ code: 'ETIMEDOUT', message: 'timeout' })
      .mockResolvedValueOnce({ status: 200, headers: {}, data: { ok: true } });

    await expect(service.makeRequest('GET', '/test')).resolves.toEqual({
      ok: true,
    });
    expect(axios).toHaveBeenCalledTimes(2);
  });

  it('does not retry a permanent 400 response', async () => {
    const error = {
      message: 'bad request',
      response: { status: 400, headers: {} },
    };
    (axios as unknown as jest.Mock).mockRejectedValue(error);

    await expect(service.makeRequest('GET', '/test')).rejects.toBe(error);
    expect(axios).toHaveBeenCalledTimes(1);
  });
});
