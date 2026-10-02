/**
 * AN OLD LINK STILL LANDS: the sections that left the Settings panel are sent
 * to their new home, not to the panel's first page.
 *
 * @covers USERMENU-05
 * @covers APPSET-03
 */
import { describe, expect, test } from 'bun:test';
import { routeSettingsRequest } from './openSettings';

describe('routeSettingsRequest', () => {
  test('the forms still open the panel on themselves', () => {
    expect(routeSettingsRequest('providers')).toEqual({ to: 'panel', section: 'providers' });
    expect(routeSettingsRequest('nodes')).toEqual({ to: 'panel', section: 'nodes' });
    expect(routeSettingsRequest(undefined)).toEqual({ to: 'panel', section: undefined });
  });

  test('the identity pages open the Profile tab', () => {
    expect(routeSettingsRequest('organization')).toEqual({ to: 'profile', page: 'organization' });
    expect(routeSettingsRequest('profile')).toEqual({ to: 'profile', page: 'profile' });
    expect(routeSettingsRequest('followers')).toEqual({ to: 'profile', page: 'followers' });
  });

  test('the preferences and the devices open the user menu on their level', () => {
    expect(routeSettingsRequest('notifications')).toEqual({ to: 'user-menu', level: 'notifications' });
    expect(routeSettingsRequest('appearance')).toEqual({ to: 'user-menu', level: 'appearance' });
    expect(routeSettingsRequest('devices')).toEqual({ to: 'user-menu', level: 'devices' });
  });

  test('an unknown id is the panel on its first page', () => {
    expect(routeSettingsRequest('privacy')).toEqual({ to: 'panel', section: undefined });
  });
});
