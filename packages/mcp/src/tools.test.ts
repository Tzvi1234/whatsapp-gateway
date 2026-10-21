import { describe, expect, it } from 'vitest';
import { LEGACY_SCOPES, SCOPES } from '@htz/core';
import { LEGACY_TOOL_NAMES, TOOL_NAMES, TOOL_SCOPES, toolDescriptors } from './tools';

describe('tool catalogue', () => {
  it('R3.1 the 12 legacy tool names are exact', () => {
    expect([...LEGACY_TOOL_NAMES]).toEqual([
      'list_automations',
      'create_automation',
      'update_automation',
      'delete_automation',
      'send_message',
      'update_reply',
      'get_thread',
      'send_reminder',
      'list_reminders',
      'cancel_reminder',
      'session_status',
      'session_reconnect',
    ]);
    expect(TOOL_NAMES).toHaveLength(25);
  });

  it('R3.1 tools/list is frozen (snapshot)', () => {
    expect(toolDescriptors()).toMatchSnapshot();
  });

  it('R3.1 legacy tools need only legacy scopes; every scope is a known scope', () => {
    for (const t of LEGACY_TOOL_NAMES) expect(LEGACY_SCOPES).toContain(TOOL_SCOPES[t]);
    for (const t of TOOL_NAMES) expect(SCOPES).toContain(TOOL_SCOPES[t]);
  });

  it('R3.2 every new tool accepts an optional account', () => {
    for (const d of toolDescriptors()) {
      if (d.name === 'list_accounts' || (LEGACY_TOOL_NAMES as readonly string[]).includes(d.name))
        continue;
      const props = d.inputSchema.properties as Record<string, unknown>;
      expect(props.account, d.name).toBeDefined();
      expect((d.inputSchema.required as string[] | undefined) ?? []).not.toContain('account');
    }
  });
});
