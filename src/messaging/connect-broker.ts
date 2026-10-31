import { ChannelModel, connect } from 'amqplib';
import { errorReason } from '../common/error-reason';

const CONNECT_TIMEOUT_MS = 5_000;

export function connectBroker(url: string): Promise<ChannelModel> {
  return connect(url, { timeout: CONNECT_TIMEOUT_MS }).catch((error: unknown) => {
    throw new Error(`could not connect to rabbitmq: ${errorReason(error)}`);
  });
}
