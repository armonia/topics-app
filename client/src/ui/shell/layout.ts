/**
 * The two measures every SARIM page shares, so the crumbs, the section strip
 * and the body start on the same left edge on every page: the side gutter of
 * the pane (the header's own padding) and the band that holds a `SubNav`
 * between the header and the scrolling body.
 */
export const PAGE_GUTTER = 'px-4';
export const SECTION_STRIP = 'shrink-0 px-4';

/** The reading column: the text of a contract, a document and the chain of signatures start on the same left edge, at the same most width. */
export const READING_COLUMN = 'w-full max-w-[760px]';
