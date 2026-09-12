/** @covers GUEST-17 GUEST-18 */
import { describe, expect, test } from 'bun:test';
import {
  approveLocalDelegatedRequest,
  createCatalogRequest,
  createDelegatedRequest,
  delegatedRequests,
  delegatedRequestStatus,
  reissueDelegatedRequest,
  revokeLocalDelegatedAuthorization,
} from './delegatedMachineAccess';

describe('delegated machine browser contract', () => {
  test('creates a purpose-specific request from an already fixed capability', () => {
    const [url, init] = createDelegatedRequest('remote-1', 'cap-1');
    expect(url).toBe('/api/machines/delegated-requests');
    expect(JSON.parse(String(init.body))).toEqual({ purpose: 'authorization', machineId: 'remote-1', capabilityId: 'cap-1' });
  });

  test('catalog bootstrap is a distinct purpose and carries no execution policy', () => {
    const [, init] = createCatalogRequest('remote-1', 'project-1');
    expect(JSON.parse(String(init.body))).toEqual({ purpose: 'catalog', machineId: 'remote-1', projectId: 'project-1' });
    expect(String(init.body)).not.toContain('capabilityId');
    expect(String(init.body)).not.toContain('model');
  });

  test('approval names only the local checkout and confined identity', () => {
    const [url, init] = approveLocalDelegatedRequest('request/1', 'project-local', 'person-local');
    expect(url).toEndWith('/request%2F1/approve');
    expect(JSON.parse(String(init.body))).toEqual({ projectId: 'project-local', localPersonId: 'person-local' });
  });

  test('node owner revokes the exact approved request, without a broad endpoint', () => {
    const [url, init] = revokeLocalDelegatedAuthorization('request/1');
    expect(url).toBe('/api/nodes/delegated-requests/request%2F1');
    expect(init.method).toBe('DELETE');
  });

  test('one-time credentials never enter browser state', () => {
    const parsed = delegatedRequests({ requests: [{
      id: 'r1', capabilityId: 'c1', purpose: 'authorization', state: 'pending', code: '123456',
      token: 'secret', credential: 'also-secret', claim: 'server-only',
    }] });
    expect(parsed).toEqual([{ id: 'r1', purpose: 'authorization', capabilityId: 'c1', state: 'pending', code: '123456', expiresAt: null }]);
    expect(parsed[0]).not.toHaveProperty('token');
    expect(parsed[0]).not.toHaveProperty('claim');
  });

  test('catalog status needs no capability and remains a verification-only request', () => {
    expect(delegatedRequests({ requests: [{
      id: 'catalog-1', purpose: 'catalog', machineId: 'node-1', state: 'pending', claim: 'server-only',
    }] })).toEqual([{
      id: 'catalog-1', purpose: 'catalog', machineId: 'node-1', state: 'pending', expiresAt: null,
    }]);
  });

  test('reissue asks the server to recover without a token in the browser', () => {
    const [url, init] = reissueDelegatedRequest('lost');
    expect(url).toBe('/api/machines/delegated-requests/lost/reissue');
    expect(JSON.parse(String(init.body))).toEqual({});
  });

  test('poll updates status without requiring the server to repeat correlation data', () => {
    const prior = { id: 'r1', purpose: 'authorization' as const, capabilityId: 'c1', state: 'pending' as const, repositoryKey: 'org/repo' };
    expect(delegatedRequestStatus({ request: { id: 'r1', state: 'active', token: 'never-store' } }, prior)).toEqual({
      id: 'r1', purpose: 'authorization', capabilityId: 'c1', state: 'active', expiresAt: null,
    });
  });

  test('parses the node authorization identity needed by the active list', () => {
    expect(delegatedRequests({ requests: [{
      id: 'r2', purpose: 'authorization', capabilityId: 'c2', state: 'active',
      authorizationId: 'a-node', localProjectId: 'checkout-node', localPersonId: 'owner-node',
    }] })[0]).toMatchObject({
      id: 'r2', state: 'active', authorizationId: 'a-node',
      localProjectId: 'checkout-node', localPersonId: 'owner-node',
    });
  });
});
