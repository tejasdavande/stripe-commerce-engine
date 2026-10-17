import 'reflect-metadata';
import { validate } from './env.validator';

describe('validate', () => {
  const base = {
    PORT: '3000',
    DATABASE_URL: 'postgresql://commerce:commerce@localhost:5432/commerce',
  };

  it('converts PORT to a number', () => {
    expect(validate(base).PORT).toBe(3000);
  });

  it('rejects a missing DATABASE_URL', () => {
    expect(() => validate({ ...base, DATABASE_URL: undefined })).toThrow();
  });
});
