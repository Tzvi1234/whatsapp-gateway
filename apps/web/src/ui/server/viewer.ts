import 'server-only';
import { cache } from 'react';
import { assertMemberPage, assertOwnerPage } from '@/server/auth';
import { getHealthMetrics, getHomeData } from '@/server/actions/read-models';
import { getQueueStats } from '@/server/actions/dashboard-extra';

/** Per-request memoised page guards and reads (layouts and pages share one round-trip). */
export const memberViewer = cache(assertMemberPage);
export const ownerViewer = cache(assertOwnerPage);
export const homeData = cache(getHomeData);
export const healthMetrics = cache(getHealthMetrics);
export const queueStats = cache(getQueueStats);
