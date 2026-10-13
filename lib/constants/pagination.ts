export const PAGE_SIZE = 10;
export const PAGE_SIZE_OPTIONS = [10, 20, 50, "all"] as const;
export type PageSizeOption = (typeof PAGE_SIZE_OPTIONS)[number];
