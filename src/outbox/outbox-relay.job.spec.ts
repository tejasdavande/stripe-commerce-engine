import { Logger } from '@nestjs/common';
import { OutboxRelayJob } from './outbox-relay.job';
import { OutboxRelayService } from './outbox-relay.service';

describe('OutboxRelayJob', () => {
  let outboxRelayService: jest.Mocked<Pick<OutboxRelayService, 'relayPending'>>;
  let job: OutboxRelayJob;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    outboxRelayService = { relayPending: jest.fn().mockResolvedValue(0) };
    job = new OutboxRelayJob(outboxRelayService as unknown as OutboxRelayService);
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('skips a tick while the previous run is still going', async () => {
    let finish!: () => void;
    outboxRelayService.relayPending.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = () => resolve(0);
      })
    );

    const first = job.run();
    await job.run();
    finish();
    await first;
    await job.run();

    expect(outboxRelayService.relayPending).toHaveBeenCalledTimes(2);
  });

  it('warns once per outage instead of on every tick', async () => {
    outboxRelayService.relayPending
      .mockRejectedValueOnce(new Error('could not connect to rabbitmq: ECONNREFUSED'))
      .mockRejectedValueOnce(new Error('could not connect to rabbitmq: ECONNREFUSED'))
      .mockResolvedValueOnce(3)
      .mockRejectedValueOnce(new Error('channel closed'));

    for (let i = 0; i < 4; i++) {
      await expect(job.run()).resolves.toBeUndefined();
    }

    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenLastCalledWith(
      'outbox relay failed, retrying every second: channel closed'
    );
  });
});
