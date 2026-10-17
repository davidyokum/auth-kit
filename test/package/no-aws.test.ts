/**
 * The canary for "tests make no AWS calls": with the test environment (vitest.config.ts uses
 * `AWS_BLOCKED_ENV`), a real SDK call can't find credentials, so it fails before any request leaves
 * this machine. If a call ever gets through, the environment block is broken: fix it first.
 */
import { CognitoIdentityProviderClient, ListUserPoolsCommand } from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient, ListTablesCommand } from '@aws-sdk/client-dynamodb';
import { describe, expect, it } from 'vitest';
import { AWS_BLOCKED_ENV } from '../../src/testing/index.js';

const NO_CREDENTIALS = /credential|profile|could not load/i;

describe('tests can’t reach AWS', () => {
  it('runs with the blocked environment', () => {
    for (const [key, value] of Object.entries(AWS_BLOCKED_ENV)) expect(process.env[key] ?? '', key).toBe(value);
  });

  it('a real DynamoDB call fails at credential lookup', async () => {
    const client = new DynamoDBClient({ region: 'us-east-1', maxAttempts: 1 });
    await expect(client.send(new ListTablesCommand({ Limit: 1 }))).rejects.toThrow(NO_CREDENTIALS);
  });

  it('a real Cognito admin call fails at credential lookup', async () => {
    const client = new CognitoIdentityProviderClient({ region: 'us-east-1', maxAttempts: 1 });
    await expect(client.send(new ListUserPoolsCommand({ MaxResults: 1 }))).rejects.toThrow(NO_CREDENTIALS);
  });
});
