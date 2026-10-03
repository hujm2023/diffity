import { describe, expect, it } from 'vitest';
import { selectedAgentId, setSelectedAgent, reviewOnlyAgent } from '../src/features/agents/selection';
import { mentionedAgentId, mentionsAgent, splitMentions } from '../src/lib/mentions';

describe('review agent selection', () => {
  it('defaults remote projects to Pi and keeps choices isolated by host and repository', () => {
    expect(selectedAgentId('ssh://selection-host-a/repo')).toBe('pi');
    expect(selectedAgentId('/selection-local/repo')).toBe('claude');
    setSelectedAgent('ssh://selection-host-a/repo', 'claude');
    expect(selectedAgentId('ssh://selection-host-a/repo')).toBe('claude');
    expect(selectedAgentId('ssh://selection-host-b/repo')).toBe('pi');
    expect(selectedAgentId('ssh://selection-host-a/other')).toBe('pi');
  });

  it('keeps Pi and all SSH agents read-only without changing local Claude behavior', () => {
    expect(reviewOnlyAgent('/repo', 'pi')).toBe(true);
    expect(reviewOnlyAgent('ssh://host/repo', 'claude')).toBe(true);
    expect(reviewOnlyAgent('ssh://host/repo', 'pi')).toBe(true);
    expect(reviewOnlyAgent('/repo', 'claude')).toBe(false);
  });
});

describe('agent mentions', () => {
  it('routes explicit handles while @agent uses the selected agent', () => {
    expect(mentionedAgentId('Please @pi review this')).toBe('pi');
    expect(mentionedAgentId('Please @Claude reply')).toBe('claude');
    expect(mentionedAgentId('@agent')).toBeUndefined();
    expect(mentionsAgent('@agent reply')).toBe(true);
    expect(splitMentions('Ask @pi').find((part) => part.mention)?.text).toBe('@pi');
  });

  it('does not route handles in code, email addresses, or package names', () => {
    for (const body of ['`@pi`', '```\n@pi\n```', 'a@pi.example', '@pi-tools', 'npm @pi/sdk']) {
      expect(mentionsAgent(body)).toBe(false);
      expect(mentionedAgentId(body)).toBeUndefined();
    }
  });
});
