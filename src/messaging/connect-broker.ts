import { ChannelModel, connect } from 'amqplib';

const CONNECT_TIMEOUT_MS = 5_000;

// a refused connection to a host with both ipv4 and ipv6 addresses is an AggregateError
// with an empty message, so fall back to its code
export function connectBroker(url: string): Promise<ChannelModel> {
  return connect(url, { timeout: CONNECT_TIMEOUT_MS }).catch((error: NodeJS.ErrnoException) => {
    throw new Error(`could not connect to rabbitmq: ${error.message || error.code}`);
  });
}
