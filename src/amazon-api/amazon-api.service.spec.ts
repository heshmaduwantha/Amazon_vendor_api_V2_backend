import { Test, TestingModule } from '@nestjs/testing';
import { AmazonApiService } from './amazon-api.service';

describe('AmazonApiService', () => {
  let service: AmazonApiService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [AmazonApiService],
    }).compile();

    service = module.get<AmazonApiService>(AmazonApiService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
