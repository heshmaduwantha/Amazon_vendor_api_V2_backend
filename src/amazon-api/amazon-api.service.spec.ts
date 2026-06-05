import { Test, TestingModule } from '@nestjs/testing';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { ConfigService } from '@nestjs/config';
import { AuthService } from '../auth/auth.service';
import { AmazonApiService } from './amazon-api.service';

describe('AmazonApiService', () => {
  let service: AmazonApiService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AmazonApiService,
        {
          provide: AuthService,
          useValue: {
            getAccessToken: jest.fn(),
            getAwsCredentials: jest.fn(() => ({})),
            getApiBaseUrl: jest.fn(() => 'https://example.test'),
            clearTokenCache: jest.fn(),
          },
        },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: CACHE_MANAGER, useValue: { get: jest.fn(), set: jest.fn(), del: jest.fn() } },
      ],
    }).compile();

    service = module.get<AmazonApiService>(AmazonApiService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
