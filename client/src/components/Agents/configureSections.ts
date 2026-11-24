/** The sections of an agent's Configure page, in the order of its column. */
export const CONFIGURE_SECTIONS = ['identity', 'job', 'channels', 'people', 'permissions', 'jobs', 'tools', 'memory', 'model', 'context', 'files'] as const;
export type ConfigureSection = (typeof CONFIGURE_SECTIONS)[number];

/** The two sections that explain what the agent receives, grouped under «Per capire». */
export const UNDERSTAND_SECTIONS: readonly ConfigureSection[] = ['context', 'files'];
