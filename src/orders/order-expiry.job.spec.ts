import { OrderExpiryJob } from './order-expiry.job';
import { OrderExpiryService } from './order-expiry.service';

describe('OrderExpiryJob', () => {
  let orderExpiryService: jest.Mocked<Pick<OrderExpiryService, 'expireUnpaid'>>;
  let job: OrderExpiryJob;

  beforeEach(() => {
    orderExpiryService = { expireUnpaid: jest.fn().mockResolvedValue(0) };
    job = new OrderExpiryJob(orderExpiryService as unknown as OrderExpiryService);
  });

  it('skips a tick while the previous run is still going', async () => {
    let finish!: () => void;
    orderExpiryService.expireUnpaid.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = () => resolve(0);
      })
    );

    const first = job.run();
    await job.run();
    finish();
    await first;
    await job.run();

    expect(orderExpiryService.expireUnpaid).toHaveBeenCalledTimes(2);
  });

  it('logs a failed run and runs again on the next tick', async () => {
    orderExpiryService.expireUnpaid.mockRejectedValueOnce(new Error('connection refused'));

    await expect(job.run()).resolves.toBeUndefined();
    await job.run();

    expect(orderExpiryService.expireUnpaid).toHaveBeenCalledTimes(2);
  });
});
