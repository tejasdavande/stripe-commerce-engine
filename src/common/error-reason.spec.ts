import { errorReason } from './error-reason';

describe('errorReason', () => {
  it('returns the message when there is no code', () => {
    expect(errorReason(new Error('channel closed'))).toBe('channel closed');
  });

  it('returns the code for an AggregateError with an empty message', () => {
    const error = Object.assign(new AggregateError([], ''), { code: 'ECONNREFUSED' });

    expect(errorReason(error)).toBe('ECONNREFUSED');
  });

  it('appends the code to a multi-line prisma message on one line', () => {
    const error = Object.assign(new Error('\nInvalid `prisma.$queryRaw()` invocation:\n\n\n'), {
      code: 'ECONNREFUSED',
    });

    expect(errorReason(error)).toBe('Invalid `prisma.$queryRaw()` invocation: (ECONNREFUSED)');
  });

  it('does not repeat a code that is already in the message', () => {
    const error = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5672'), {
      code: 'ECONNREFUSED',
    });

    expect(errorReason(error)).toBe('connect ECONNREFUSED 127.0.0.1:5672');
  });

  it('falls back to the name when there is neither', () => {
    expect(errorReason(new AggregateError([], ''))).toBe('AggregateError');
  });

  it('stringifies non-errors', () => {
    expect(errorReason('boom')).toBe('boom');
  });
});
