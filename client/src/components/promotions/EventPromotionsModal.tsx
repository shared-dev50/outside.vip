import React, { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  TrendingUp,
  Megaphone,
  Link2,
  Copy,
  Check,
  RotateCw,
  Trash2,
  Power,
  Edit3,
  Plus,
  X,
  Search,
  BarChart3,
  Users,
  MousePointerClick,
  Globe,
  Sparkles,
  AlertCircle,
  CheckCircle2,
  Layers,
} from 'lucide-react';
import { api } from '../../lib/api';
import {
  OrganizerEventItem,
  PromotionLinkItem,
  PromotionLinkStatus,
  DailyTrafficItem,
} from '../../types';

export interface EventPromotionsModalProps {
  isOpen: boolean;
  onClose: () => void;
  event: OrganizerEventItem | null;
}

type DateRangePreset = '7D' | '14D' | '30D' | 'ALL';

export const EventPromotionsModal: React.FC<EventPromotionsModalProps> = ({
  isOpen,
  onClose,
  event,
}) => {
  if (!isOpen || !event) return null;

  const queryClient = useQueryClient();

  // Navigation tab
  const [activeTab, setActiveTab] = useState<'LINKS' | 'CREATE' | 'ANALYTICS'>('LINKS');

  // Search & Filters in Links tab
  const [searchQuery, setSearchQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<'ALL' | 'CAMPAIGN' | 'HOST'>('ALL');

  // Analytics filter state
  const [analyticsLinkId, setAnalyticsLinkId] = useState<string>('');
  const [dateRangePreset, setDateRangePreset] = useState<DateRangePreset>('30D');

  // Notification state
  const [notification, setNotification] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  const showNotification = (type: 'success' | 'error', message: string) => {
    setNotification({ type, message });
    setTimeout(() => setNotification(null), 4000);
  };

  // Create Campaign Link Form state
  const [createName, setCreateName] = useState('');
  const [createCustomSlug, setCreateCustomSlug] = useState('');

  // Customize Slug Dialog state
  const [linkToCustomizeSlug, setLinkToCustomizeSlug] = useState<PromotionLinkItem | null>(null);
  const [customSlugInput, setCustomSlugInput] = useState('');
  const [slugError, setSlugError] = useState<string | null>(null);

  // Archive Confirmation Dialog state
  const [linkToArchive, setLinkToArchive] = useState<PromotionLinkItem | null>(null);

  // Copy Feedback state
  const [copiedSlug, setCopiedSlug] = useState<string | null>(null);

  // Calculate actual Date parameters for analytics
  const dateParams = useMemo(() => {
    const now = new Date();
    if (dateRangePreset === '7D') {
      const start = new Date(now.getTime() - 7 * 86400000);
      start.setUTCHours(0, 0, 0, 0);
      return { startDate: start.toISOString(), endDate: now.toISOString() };
    }
    if (dateRangePreset === '14D') {
      const start = new Date(now.getTime() - 14 * 86400000);
      start.setUTCHours(0, 0, 0, 0);
      return { startDate: start.toISOString(), endDate: now.toISOString() };
    }
    if (dateRangePreset === '30D') {
      const start = new Date(now.getTime() - 30 * 86400000);
      start.setUTCHours(0, 0, 0, 0);
      return { startDate: start.toISOString(), endDate: now.toISOString() };
    }
    return { startDate: undefined, endDate: undefined };
  }, [dateRangePreset]);

  // Query: Promotional Links
  const {
    data: linksData,
    isLoading: isLoadingLinks,
    isFetching: isFetchingLinks,
    refetch: refetchLinks,
    error: linksError,
  } = useQuery({
    queryKey: ['event-promotion-links', event.id],
    queryFn: () => api.promotions.getLinks(event.id),
    enabled: Boolean(event.id),
  });

  const links = linksData || [];

  // Query: Traffic Analytics
  const {
    data: analyticsData,
    isLoading: isLoadingAnalytics,
    isFetching: isFetchingAnalytics,
    refetch: refetchAnalytics,
    error: analyticsError,
  } = useQuery({
    queryKey: [
      'event-promotion-analytics',
      event.id,
      analyticsLinkId || 'all',
      dateRangePreset,
      dateParams.startDate,
      dateParams.endDate,
    ],
    queryFn: () =>
      api.promotions.getAnalytics(event.id, {
        linkId: analyticsLinkId || undefined,
        startDate: dateParams.startDate,
        endDate: dateParams.endDate,
      }),
    enabled: Boolean(event.id) && activeTab === 'ANALYTICS',
  });

  const traffic = analyticsData?.traffic;

  // Mutations
  const createCampaignMutation = useMutation({
    mutationFn: (data: { name: string; slug?: string }) =>
      api.promotions.createCampaignLink(event.id, data),
    onSuccess: (newLink) => {
      queryClient.invalidateQueries({ queryKey: ['event-promotion-links', event.id] });
      queryClient.invalidateQueries({ queryKey: ['event-promotion-analytics', event.id] });
      setCreateName('');
      setCreateCustomSlug('');
      setActiveTab('LINKS');
      showNotification(
        'success',
        `Campaign link "${newLink.name}" created with slug /r/${newLink.primarySlug}`
      );
    },
    onError: (err: any) => {
      showNotification('error', err?.message || 'Failed to create campaign link');
    },
  });

  const updateLinkMutation = useMutation({
    mutationFn: (params: { linkId: string; updates: { name?: string; status?: PromotionLinkStatus } }) =>
      api.promotions.updateLink(event.id, params.linkId, params.updates),
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey: ['event-promotion-links', event.id] });
      queryClient.invalidateQueries({ queryKey: ['event-promotion-analytics', event.id] });
      setLinkToArchive(null);
      showNotification('success', `Promotional link "${updated.name}" updated`);
    },
    onError: (err: any) => {
      showNotification('error', err?.message || 'Failed to update link status');
    },
  });

  const customizeSlugMutation = useMutation({
    mutationFn: (params: { linkId: string; slug: string }) =>
      api.promotions.customizeSlug(event.id, params.linkId, params.slug),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['event-promotion-links', event.id] });
      queryClient.invalidateQueries({ queryKey: ['event-promotion-analytics', event.id] });
      setLinkToCustomizeSlug(null);
      setCustomSlugInput('');
      setSlugError(null);
      showNotification('success', `Primary slug updated to /r/${result.primarySlug}`);
    },
    onError: (err: any) => {
      setSlugError(err?.message || 'Failed to update slug. It may already be in use or reserved.');
    },
  });

  const handleCopy = (slug: string) => {
    const origin = typeof window !== 'undefined' && window.location?.origin ? window.location.origin : '';
    const url = origin ? `${origin}/r/${slug}` : `/r/${slug}`;
    navigator.clipboard.writeText(url);
    setCopiedSlug(slug);
    setTimeout(() => setCopiedSlug(null), 2000);
  };

  const handleCreateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!createName.trim()) {
      showNotification('error', 'Campaign name is required');
      return;
    }
    createCampaignMutation.mutate({
      name: createName.trim(),
      slug: createCustomSlug.trim() ? createCustomSlug.trim().toLowerCase() : undefined,
    });
  };

  const handleCustomizeSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!linkToCustomizeSlug) return;
    const clean = customSlugInput.trim().toLowerCase();
    if (!clean) {
      setSlugError('Slug cannot be empty');
      return;
    }
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(clean) || clean.length < 2 || clean.length > 64) {
      setSlugError('Slug must be 2-64 lowercase letters, numbers, and single hyphens.');
      return;
    }
    customizeSlugMutation.mutate({
      linkId: linkToCustomizeSlug.id,
      slug: clean,
    });
  };

  // Filtered links
  const filteredLinks = links.filter((link) => {
    if (typeFilter !== 'ALL' && link.type !== typeFilter) return false;
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const matchName = link.name.toLowerCase().includes(q);
      const matchSlug = link.primarySlug?.toLowerCase().includes(q);
      const matchHost = link.host?.name?.toLowerCase().includes(q) || link.host?.email?.toLowerCase().includes(q);
      return matchName || matchSlug || matchHost;
    }
    return true;
  });

  const campaignCount = links.filter((l) => l.type === 'CAMPAIGN').length;
  const hostCount = links.filter((l) => l.type === 'HOST').length;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4 sm:p-6"
      onClick={onClose}
    >
      <div
        className="w-full max-w-4xl max-h-[90vh] bg-white rounded-2xl border border-stone-200 shadow-2xl flex flex-col overflow-hidden animate-in fade-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-4.5 border-b border-stone-100 bg-[#FAF8F5]">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-stone-900 text-white flex items-center justify-center shadow-2xs">
              <TrendingUp className="w-5 h-5 text-amber-400" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-display font-bold text-base text-stone-900">
                  Promotions &amp; Traffic Analytics
                </h3>
                <span className="text-xs text-stone-400">·</span>
                <span className="text-xs text-stone-600 font-sans truncate max-w-[280px]">
                  {event.title}
                </span>
              </div>
              <p className="text-[11px] text-stone-500 font-mono">
                Traffic-tracking campaign links, slug customization, and unique visitor discovery
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                refetchLinks();
                if (activeTab === 'ANALYTICS') refetchAnalytics();
              }}
              disabled={isFetchingLinks || isFetchingAnalytics}
              className="p-2 rounded-lg text-stone-500 hover:text-stone-900 hover:bg-stone-100 transition-colors cursor-pointer"
              title="Refresh Data"
            >
              <RotateCw
                className={`w-4 h-4 ${
                  isFetchingLinks || isFetchingAnalytics ? 'animate-spin text-stone-900' : ''
                }`}
              />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-2 rounded-lg text-stone-400 hover:text-stone-700 hover:bg-stone-100 transition-colors cursor-pointer"
              aria-label="Close"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Notification Toast */}
        {notification && (
          <div
            className={`px-6 py-2.5 text-xs font-mono flex items-center justify-between border-b ${
              notification.type === 'success'
                ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                : 'bg-rose-50 text-rose-800 border-rose-200'
            }`}
          >
            <div className="flex items-center gap-2">
              {notification.type === 'success' ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-600" />
              ) : (
                <AlertCircle className="w-4 h-4 text-rose-600" />
              )}
              <span>{notification.message}</span>
            </div>
            <button
              type="button"
              onClick={() => setNotification(null)}
              className="text-stone-500 hover:text-stone-800 cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Navigation Tabs */}
        <div className="px-6 pt-3 border-b border-stone-200 bg-white flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setActiveTab('LINKS')}
              className={`px-3 py-2 text-xs font-mono font-bold uppercase tracking-wider border-b-2 transition-colors cursor-pointer ${
                activeTab === 'LINKS'
                  ? 'border-stone-900 text-stone-900'
                  : 'border-transparent text-stone-500 hover:text-stone-800'
              }`}
            >
              Campaign Links ({links.length})
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('ANALYTICS')}
              className={`px-3 py-2 text-xs font-mono font-bold uppercase tracking-wider border-b-2 transition-colors cursor-pointer flex items-center gap-1.5 ${
                activeTab === 'ANALYTICS'
                  ? 'border-stone-900 text-stone-900'
                  : 'border-transparent text-stone-500 hover:text-stone-800'
              }`}
            >
              <BarChart3 className="w-3.5 h-3.5" />
              Traffic Analytics
            </button>
          </div>

          <button
            type="button"
            onClick={() => setActiveTab('CREATE')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-mono uppercase font-bold tracking-wider transition-colors shadow-2xs mb-2 cursor-pointer ${
              activeTab === 'CREATE'
                ? 'bg-stone-900 text-white'
                : 'bg-stone-100 hover:bg-stone-200 text-stone-800 border border-stone-200'
            }`}
          >
            <Plus className="w-3.5 h-3.5" />
            Create Campaign Link
          </button>
        </div>

        {/* Body Container */}
        <div className="flex-1 overflow-y-auto p-6">
          {/* =========================================================================
              TAB 1: PROMOTIONAL LINKS ROSTER
             ========================================================================= */}
          {activeTab === 'LINKS' && (
            <div className="space-y-4">
              {/* Filter & Search Bar */}
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3">
                <div className="relative flex-1 max-w-sm">
                  <Search className="w-3.5 h-3.5 text-stone-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Search campaigns, slugs or hosts..."
                    className="w-full pl-9 pr-3 py-1.5 rounded-xl bg-stone-50 border border-stone-200 text-xs font-sans text-stone-900 placeholder:text-stone-400 focus:outline-none focus:border-stone-900"
                  />
                </div>

                <div className="flex items-center gap-1.5 text-xs font-mono">
                  <button
                    type="button"
                    onClick={() => setTypeFilter('ALL')}
                    className={`px-2.5 py-1 rounded-lg border text-[11px] transition-colors cursor-pointer ${
                      typeFilter === 'ALL'
                        ? 'bg-stone-900 text-white border-stone-900'
                        : 'bg-white text-stone-600 border-stone-200 hover:bg-stone-50'
                    }`}
                  >
                    All ({links.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setTypeFilter('CAMPAIGN')}
                    className={`px-2.5 py-1 rounded-lg border text-[11px] transition-colors cursor-pointer ${
                      typeFilter === 'CAMPAIGN'
                        ? 'bg-purple-900 text-white border-purple-900'
                        : 'bg-white text-stone-600 border-stone-200 hover:bg-stone-50'
                    }`}
                  >
                    Campaigns ({campaignCount})
                  </button>
                  <button
                    type="button"
                    onClick={() => setTypeFilter('HOST')}
                    className={`px-2.5 py-1 rounded-lg border text-[11px] transition-colors cursor-pointer ${
                      typeFilter === 'HOST'
                        ? 'bg-amber-800 text-white border-amber-800'
                        : 'bg-white text-stone-600 border-stone-200 hover:bg-stone-50'
                    }`}
                  >
                    Host Links ({hostCount})
                  </button>
                </div>
              </div>

              {/* Links Table */}
              {isLoadingLinks ? (
                <div className="py-16 text-center text-stone-500 font-mono text-xs flex items-center justify-center gap-2">
                  <RotateCw className="w-4 h-4 animate-spin text-stone-700" />
                  <span>Loading promotional links...</span>
                </div>
              ) : linksError ? (
                <div className="py-12 text-center text-rose-600 font-mono text-xs">
                  Failed to load promotional links. Please try again.
                </div>
              ) : filteredLinks.length === 0 ? (
                <div className="py-16 text-center space-y-3">
                  <div className="w-12 h-12 rounded-2xl bg-stone-100 text-stone-400 flex items-center justify-center mx-auto">
                    <Link2 className="w-6 h-6" />
                  </div>
                  <h4 className="font-display font-bold text-stone-800 text-sm">
                    No Promotional Links Found
                  </h4>
                  <p className="text-xs text-stone-500 max-w-sm mx-auto">
                    Create your first campaign link (e.g. for Instagram, WhatsApp, or Newsletter) to track discovery traffic.
                  </p>
                  <button
                    type="button"
                    onClick={() => setActiveTab('CREATE')}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-stone-900 hover:bg-black text-white text-xs font-mono uppercase font-bold tracking-wider transition-colors shadow-xs cursor-pointer mt-2"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Create Campaign Link
                  </button>
                </div>
              ) : (
                <div className="overflow-x-auto border border-stone-200 rounded-xl">
                  <table className="w-full text-left text-xs border-collapse">
                    <thead>
                      <tr className="border-b border-stone-200 bg-stone-50/80 text-[11px] font-mono uppercase text-stone-500">
                        <th className="py-2.5 px-3">Campaign / Host Name</th>
                        <th className="py-2.5 px-3">Type</th>
                        <th className="py-2.5 px-3">Primary Short Link</th>
                        <th className="py-2.5 px-3">Status</th>
                        <th className="py-2.5 px-3 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-stone-100 font-sans">
                      {filteredLinks.map((link) => (
                        <tr key={link.id} className="hover:bg-stone-50/50 transition-colors">
                          <td className="py-3 px-3">
                            <div className="font-semibold text-stone-900">{link.name}</div>
                            {link.type === 'HOST' && link.host && (
                              <div className="text-[11px] font-mono text-amber-800 flex items-center gap-1 mt-0.5">
                                <Users className="w-3 h-3 text-amber-600" />
                                {`Host: ${link.host.name || link.host.email}`}
                              </div>
                            )}
                            <div className="text-[10px] font-mono text-stone-400 mt-0.5">
                              Created {new Date(link.createdAt).toLocaleDateString()}
                            </div>
                          </td>
                          <td className="py-3 px-3">
                            {link.type === 'CAMPAIGN' ? (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono uppercase font-bold bg-purple-50 text-purple-700 border border-purple-200">
                                <Megaphone className="w-3 h-3" />
                                Campaign
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono uppercase font-bold bg-amber-50 text-amber-800 border border-amber-300">
                                <Users className="w-3 h-3" />
                                Host Link
                              </span>
                            )}
                          </td>
                          <td className="py-3 px-3 font-mono text-[11px]">
                            {link.status === 'ACTIVE' && link.primarySlug ? (
                              <div className="space-y-1">
                                <div className="flex items-center gap-1.5">
                                  <span className="bg-stone-100 px-2 py-0.5 rounded text-stone-800 font-semibold">
                                    {`/r/${link.primarySlug}`}
                                  </span>
                                  <button
                                    type="button"
                                    onClick={() => handleCopy(link.primarySlug!)}
                                    className="p-1 rounded hover:bg-stone-200 text-stone-500 hover:text-stone-800 transition-colors cursor-pointer"
                                    title="Copy Promotional Link"
                                  >
                                    {copiedSlug === link.primarySlug ? (
                                      <Check className="w-3.5 h-3.5 text-emerald-600" />
                                    ) : (
                                      <Copy className="w-3.5 h-3.5" />
                                    )}
                                  </button>
                                </div>
                                {link.historicalAliases && link.historicalAliases.length > 0 && (
                                  <div className="text-[10px] text-stone-400 truncate max-w-xs" title={`Aliases: ${link.historicalAliases.join(', ')}`}>
                                    Aliases: {link.historicalAliases.map((a) => `/r/${a}`).join(', ')}
                                  </div>
                                )}
                              </div>
                            ) : link.status === 'DISABLED' ? (
                              <span className="text-stone-400 italic">Link paused</span>
                            ) : (
                              <span className="text-rose-400 italic">Link archived</span>
                            )}
                          </td>
                          <td className="py-3 px-3">
                            {link.status === 'ACTIVE' ? (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono uppercase font-bold bg-emerald-50 text-emerald-800 border border-emerald-300">
                                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                                Active
                              </span>
                            ) : link.status === 'DISABLED' ? (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono uppercase font-bold bg-stone-100 text-stone-600 border border-stone-200">
                                <span className="w-1.5 h-1.5 rounded-full bg-stone-400" />
                                Paused
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono uppercase font-bold bg-rose-50 text-rose-700 border border-rose-200">
                                Archived
                              </span>
                            )}
                          </td>
                          <td className="py-3 px-3 text-right">
                            <div className="flex items-center justify-end gap-1.5">
                              {/* View Analytics for Link */}
                              <button
                                type="button"
                                onClick={() => {
                                  setAnalyticsLinkId(link.id);
                                  setActiveTab('ANALYTICS');
                                }}
                                className="p-1.5 rounded-lg bg-stone-100 hover:bg-stone-200 text-stone-600 hover:text-stone-900 transition-colors cursor-pointer"
                                title="View Link Traffic Analytics"
                              >
                                <BarChart3 className="w-3.5 h-3.5" />
                              </button>

                              {/* Customize Slug */}
                              {link.status !== 'ARCHIVED' && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setLinkToCustomizeSlug(link);
                                    setCustomSlugInput(link.primarySlug || '');
                                    setSlugError(null);
                                  }}
                                  className="p-1.5 rounded-lg bg-stone-100 hover:bg-stone-200 text-stone-600 hover:text-stone-900 transition-colors cursor-pointer"
                                  title="Customize Slug"
                                >
                                  <Edit3 className="w-3.5 h-3.5" />
                                </button>
                              )}

                              {/* Pause / Resume Button */}
                              {link.status !== 'ARCHIVED' && (
                                <button
                                  type="button"
                                  onClick={() =>
                                    updateLinkMutation.mutate({
                                      linkId: link.id,
                                      updates: {
                                        status: link.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE',
                                      },
                                    })
                                  }
                                  disabled={updateLinkMutation.isPending}
                                  className={`p-1.5 rounded-lg transition-colors cursor-pointer ${
                                    link.status === 'ACTIVE'
                                      ? 'bg-amber-50 hover:bg-amber-100 text-amber-700'
                                      : 'bg-emerald-50 hover:bg-emerald-100 text-emerald-700'
                                  }`}
                                  title={link.status === 'ACTIVE' ? 'Pause Link' : 'Activate Link'}
                                >
                                  <Power className="w-3.5 h-3.5" />
                                </button>
                              )}

                              {/* Archive Button */}
                              {link.status !== 'ARCHIVED' && (
                                <button
                                  type="button"
                                  onClick={() => setLinkToArchive(link)}
                                  className="p-1.5 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-600 hover:text-rose-800 transition-colors cursor-pointer"
                                  title="Archive Link"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {/* =========================================================================
              TAB 2: CREATE CAMPAIGN LINK FORM
             ========================================================================= */}
          {activeTab === 'CREATE' && (
            <form onSubmit={handleCreateSubmit} className="max-w-xl mx-auto space-y-6 py-2">
              <div className="space-y-1">
                <h4 className="font-display font-bold text-lg text-stone-900">
                  Create Promotional Campaign Link
                </h4>
                <p className="text-xs text-stone-500">
                  Generate a dedicated tracking link to measure unique visitors and discovery channels.
                </p>
              </div>

              {/* Informational Product Notice */}
              <div className="p-3.5 rounded-xl bg-amber-50/50 border border-amber-200 text-xs text-amber-900 flex items-start gap-2.5">
                <Sparkles className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                <div className="space-y-0.5">
                  <span className="font-semibold block">Traffic Analytics Only</span>
                  <span className="text-[11px] text-amber-800 leading-relaxed block">
                    Promotional links measure incoming clicks and deduplicated unique visitors. They do not track ticket sales or attendee purchase attribution.
                  </span>
                </div>
              </div>

              {/* Campaign Name */}
              <div className="space-y-1.5">
                <label className="text-[11px] font-mono text-stone-600 uppercase font-semibold block">
                  Campaign Name *
                </label>
                <div className="relative">
                  <Megaphone className="w-4 h-4 text-stone-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    required
                    maxLength={100}
                    value={createName}
                    onChange={(e) => setCreateName(e.target.value)}
                    placeholder="e.g. Instagram Bio, Twitter Announcement, WhatsApp VIP"
                    className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-stone-200 text-xs font-sans text-stone-900 placeholder:text-stone-400 focus:outline-none focus:border-stone-900 shadow-2xs"
                  />
                </div>
                <span className="text-[10px] text-stone-400 font-mono block">
                  A descriptive channel name for your tracking analytics.
                </span>
              </div>

              {/* Custom Slug (Optional) */}
              <div className="space-y-1.5">
                <label className="text-[11px] font-mono text-stone-600 uppercase font-semibold block">
                  Custom Slug (Optional)
                </label>
                <div className="relative">
                  <span className="text-xs font-mono text-stone-400 absolute left-3.5 top-1/2 -translate-y-1/2">
                    /r/
                  </span>
                  <input
                    type="text"
                    value={createCustomSlug}
                    onChange={(e) => setCreateCustomSlug(e.target.value)}
                    placeholder="summer-vip-launch"
                    className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-stone-200 text-xs font-mono text-stone-900 placeholder:text-stone-400 focus:outline-none focus:border-stone-900 shadow-2xs"
                  />
                </div>
                <span className="text-[10px] text-stone-400 font-mono block">
                  Leave blank to auto-generate a slug from the campaign name, or choose 2-64 lowercase letters, numbers, and hyphens.
                </span>
              </div>

              {/* Actions */}
              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setActiveTab('LINKS')}
                  className="px-4 py-2 rounded-xl border border-stone-200 text-xs font-mono text-stone-600 hover:text-stone-900 hover:bg-stone-50 transition-colors shadow-2xs cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={createCampaignMutation.isPending}
                  className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-xl bg-stone-900 hover:bg-black text-white text-xs font-mono uppercase font-bold tracking-wider transition-colors shadow-xs disabled:opacity-50 cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" />
                  {createCampaignMutation.isPending ? 'Creating Link...' : 'Create Campaign Link'}
                </button>
              </div>
            </form>
          )}

          {/* =========================================================================
              TAB 3: CAMPAIGN TRAFFIC ANALYTICS
             ========================================================================= */}
          {activeTab === 'ANALYTICS' && (
            <div className="space-y-6">
              {/* Analytics Header Controls */}
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 p-4 rounded-xl bg-stone-50 border border-stone-200">
                {/* Link Filter Dropdown */}
                <div className="flex-1 max-w-sm">
                  <label className="text-[10px] font-mono text-stone-500 uppercase font-semibold block mb-1">
                    Filter by Link
                  </label>
                  <select
                    value={analyticsLinkId}
                    onChange={(e) => setAnalyticsLinkId(e.target.value)}
                    className="w-full px-3 py-1.5 rounded-lg border border-stone-200 bg-white text-xs font-sans text-stone-800 focus:outline-none focus:border-stone-900"
                  >
                    <option value="">All Promotional Links (Event-Wide)</option>
                    {links.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name} ({l.type === 'CAMPAIGN' ? 'Campaign' : 'Host'}: /r/{l.primarySlug || '...' })
                      </option>
                    ))}
                  </select>
                </div>

                {/* Date Range Preset Selector */}
                <div>
                  <label className="text-[10px] font-mono text-stone-500 uppercase font-semibold block mb-1">
                    Date Window
                  </label>
                  <div className="flex items-center gap-1 bg-white p-1 rounded-lg border border-stone-200 text-xs font-mono">
                    {(['7D', '14D', '30D', 'ALL'] as DateRangePreset[]).map((preset) => (
                      <button
                        key={preset}
                        type="button"
                        onClick={() => setDateRangePreset(preset)}
                        className={`px-2 py-1 rounded text-[11px] font-medium transition-colors cursor-pointer ${
                          dateRangePreset === preset
                            ? 'bg-stone-900 text-white'
                            : 'text-stone-600 hover:text-stone-900'
                        }`}
                      >
                        {preset === '7D'
                          ? '7 Days'
                          : preset === '14D'
                          ? '14 Days'
                          : preset === '30D'
                          ? '30 Days'
                          : 'All Time'}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {/* Traffic Invariant Notice */}
              <div className="p-3 rounded-xl bg-stone-100/70 border border-stone-200 text-[11px] font-mono text-stone-600 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Globe className="w-3.5 h-3.5 text-stone-500" />
                  <span>Traffic discovery analytics only. Zero ticket sales or financial attribution.</span>
                </div>
                {analyticsLinkId && (
                  <button
                    type="button"
                    onClick={() => setAnalyticsLinkId('')}
                    className="text-stone-800 hover:underline font-semibold"
                  >
                    Clear Filter
                  </button>
                )}
              </div>

              {/* Analytics Query States */}
              {isLoadingAnalytics ? (
                <div className="py-20 text-center text-stone-500 font-mono text-xs flex items-center justify-center gap-2">
                  <RotateCw className="w-4 h-4 animate-spin text-stone-700" />
                  <span>Aggregating promotional traffic metrics...</span>
                </div>
              ) : analyticsError ? (
                <div className="py-16 text-center text-rose-600 font-mono text-xs">
                  Failed to load traffic analytics. Please try again.
                </div>
              ) : !traffic || (traffic.totalClicks === 0 && traffic.uniqueVisitors === 0) ? (
                /* Empty Analytics State */
                <div className="py-16 text-center space-y-3 bg-stone-50/50 rounded-2xl border border-stone-200">
                  <div className="w-12 h-12 rounded-2xl bg-white border border-stone-200 text-stone-400 flex items-center justify-center mx-auto shadow-2xs">
                    <BarChart3 className="w-6 h-6" />
                  </div>
                  <h4 className="font-display font-bold text-stone-900 text-sm">
                    No Promotional Traffic Recorded Yet
                  </h4>
                  <p className="text-xs text-stone-500 max-w-sm mx-auto leading-relaxed">
                    Share your campaign or host promotional links on social media, Instagram bio, or WhatsApp groups to start tracking visitor discovery.
                  </p>
                  <button
                    type="button"
                    onClick={() => setActiveTab('CREATE')}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-stone-900 hover:bg-black text-white text-xs font-mono uppercase font-bold tracking-wider transition-colors shadow-xs cursor-pointer mt-1"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Create Campaign Link
                  </button>
                </div>
              ) : (
                /* Analytics Dashboard Content */
                <div className="space-y-6 animate-in fade-in duration-200">
                  {/* KPI Metric Cards */}
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                    {/* Total Clicks */}
                    <div className="p-4 rounded-xl bg-white border border-stone-200 shadow-2xs space-y-1">
                      <div className="flex items-center justify-between text-stone-500 text-[11px] font-mono uppercase font-semibold">
                        <span>Total Clicks</span>
                        <MousePointerClick className="w-4 h-4 text-stone-400" />
                      </div>
                      <div className="text-2xl font-display font-bold text-stone-900">
                        {traffic.totalClicks.toLocaleString()}
                      </div>
                      <span className="text-[10px] text-stone-400 font-mono block">
                        Raw redirect visits logged
                      </span>
                    </div>

                    {/* Unique Visitors */}
                    <div className="p-4 rounded-xl bg-white border border-stone-200 shadow-2xs space-y-1">
                      <div className="flex items-center justify-between text-stone-500 text-[11px] font-mono uppercase font-semibold">
                        <span>Unique Visitors</span>
                        <Users className="w-4 h-4 text-amber-500" />
                      </div>
                      <div className="text-2xl font-display font-bold text-stone-900">
                        {traffic.uniqueVisitors.toLocaleString()}
                      </div>
                      <span className="text-[10px] text-stone-400 font-mono block">
                        Deduplicated unique visitors
                      </span>
                    </div>

                    {/* Click-to-Visitor Ratio */}
                    <div className="p-4 rounded-xl bg-white border border-stone-200 shadow-2xs space-y-1">
                      <div className="flex items-center justify-between text-stone-500 text-[11px] font-mono uppercase font-semibold">
                        <span>Visits per Visitor</span>
                        <TrendingUp className="w-4 h-4 text-stone-400" />
                      </div>
                      <div className="text-2xl font-display font-bold text-stone-900">
                        {traffic.uniqueVisitors > 0
                          ? (traffic.totalClicks / traffic.uniqueVisitors).toFixed(1)
                          : '0.0'}
                      </div>
                      <span className="text-[10px] text-stone-400 font-mono block">
                        Repeat discovery frequency
                      </span>
                    </div>
                  </div>

                  {/* Daily Visits Visualization (Custom Bar Chart) */}
                  <div className="p-5 rounded-xl bg-white border border-stone-200 shadow-2xs space-y-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <h5 className="font-display font-bold text-sm text-stone-900">
                          Daily Visitor Discovery Trend
                        </h5>
                        <p className="text-[11px] text-stone-500 font-mono">
                          Unique visitors vs total clicks over time
                        </p>
                      </div>
                      <div className="flex items-center gap-3 text-[10px] font-mono uppercase">
                        <div className="flex items-center gap-1.5">
                          <span className="w-3 h-3 rounded-xs bg-stone-900" />
                          <span className="text-stone-600">Clicks</span>
                        </div>
                        <div className="flex items-center gap-1.5">
                          <span className="w-3 h-3 rounded-xs bg-amber-400" />
                          <span className="text-stone-600">Unique Visitors</span>
                        </div>
                      </div>
                    </div>

                    {traffic.dailyVisits.length === 0 ? (
                      <div className="py-8 text-center text-xs font-mono text-stone-400">
                        No daily activity in this date range.
                      </div>
                    ) : (
                      /* SVG Bar Chart Visualization */
                      <div className="space-y-2 pt-2">
                        {(() => {
                          const maxClicks = Math.max(
                            ...traffic.dailyVisits.map((d) => d.clicks),
                            1
                          );
                          return (
                            <div className="flex items-end gap-2 h-44 border-b border-stone-100 pb-2 px-1 overflow-x-auto">
                              {traffic.dailyVisits.map((d: DailyTrafficItem) => {
                                const clickPercent = Math.min(100, Math.round((d.clicks / maxClicks) * 100));
                                const visitorPercent = Math.min(100, Math.round((d.uniqueVisitors / maxClicks) * 100));
                                const formattedDate = new Date(d.date).toLocaleDateString('en-US', {
                                  month: 'short',
                                  day: 'numeric',
                                  timeZone: 'UTC',
                                });

                                return (
                                  <div
                                    key={d.date}
                                    className="flex-1 min-w-[36px] flex flex-col items-center gap-1.5 h-full justify-end group relative"
                                  >
                                    {/* Hover Tooltip */}
                                    <div className="absolute -top-12 z-20 hidden group-hover:flex flex-col items-center pointer-events-none">
                                      <div className="bg-stone-900 text-white text-[10px] font-mono px-2 py-1 rounded shadow-lg whitespace-nowrap">
                                        <span>{formattedDate}</span>: {d.clicks} clicks · {d.uniqueVisitors} visitors
                                      </div>
                                      <div className="w-2 h-2 bg-stone-900 rotate-45 -mt-1" />
                                    </div>

                                    {/* Dual Bars */}
                                    <div className="w-full flex items-end justify-center gap-1 h-32">
                                      {/* Clicks Bar */}
                                      <div
                                        className="w-2.5 bg-stone-900 rounded-t-sm transition-all group-hover:bg-black"
                                        style={{ height: `${Math.max(4, clickPercent)}%` }}
                                        title={`${d.clicks} clicks`}
                                      />
                                      {/* Unique Visitors Bar */}
                                      <div
                                        className="w-2.5 bg-amber-400 rounded-t-sm transition-all group-hover:bg-amber-500"
                                        style={{ height: `${Math.max(4, visitorPercent)}%` }}
                                        title={`${d.uniqueVisitors} unique visitors`}
                                      />
                                    </div>

                                    {/* Date Label */}
                                    <span className="text-[9px] font-mono text-stone-500 truncate max-w-full">
                                      {formattedDate}
                                    </span>
                                  </div>
                                );
                              })}
                            </div>
                          );
                        })()}
                      </div>
                    )}
                  </div>

                  {/* Two-Column Breakdown: Referrers & UTM Sources */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    {/* Top Referrers */}
                    <div className="p-4 rounded-xl bg-white border border-stone-200 shadow-2xs space-y-3">
                      <div className="flex items-center gap-2">
                        <Globe className="w-4 h-4 text-stone-600" />
                        <h6 className="font-display font-bold text-xs text-stone-900">
                          Top Traffic Referrers
                        </h6>
                      </div>
                      {traffic.topReferrers.length === 0 ? (
                        <p className="text-xs text-stone-400 font-mono py-2">
                          No referrer headers captured.
                        </p>
                      ) : (
                        <div className="space-y-2">
                          {traffic.topReferrers.map((ref) => {
                            const percent =
                              traffic.totalClicks > 0
                                ? Math.round((ref.clicks / traffic.totalClicks) * 100)
                                : 0;
                            return (
                              <div key={ref.referrer} className="space-y-1">
                                <div className="flex items-center justify-between text-xs font-mono">
                                  <span className="text-stone-800 truncate max-w-[200px]" title={ref.referrer}>
                                    {ref.referrer}
                                  </span>
                                  <span className="text-stone-500 font-bold">
                                    {ref.clicks} <span className="font-normal text-stone-400">({percent}%)</span>
                                  </span>
                                </div>
                                <div className="h-1.5 w-full bg-stone-100 rounded-full overflow-hidden">
                                  <div
                                    className="h-full bg-stone-800 rounded-full"
                                    style={{ width: `${percent}%` }}
                                  />
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>

                    {/* Top UTM Sources */}
                    <div className="p-4 rounded-xl bg-white border border-stone-200 shadow-2xs space-y-3">
                      <div className="flex items-center gap-2">
                        <Layers className="w-4 h-4 text-stone-600" />
                        <h6 className="font-display font-bold text-xs text-stone-900">
                          UTM Source Distribution
                        </h6>
                      </div>
                      {traffic.utmBreakdown.length === 0 ? (
                        <p className="text-xs text-stone-400 font-mono py-2">
                          No UTM parameters recorded on traffic links.
                        </p>
                      ) : (
                        <div className="space-y-2">
                          {traffic.utmBreakdown.map((utm) => {
                            const percent =
                              traffic.totalClicks > 0
                                ? Math.round((utm.clicks / traffic.totalClicks) * 100)
                                : 0;
                            return (
                              <div key={utm.source || 'direct'} className="space-y-1">
                                <div className="flex items-center justify-between text-xs font-mono">
                                  <span className="text-stone-800 truncate max-w-[200px]">
                                    {utm.source || '(None / Direct)'}
                                  </span>
                                  <span className="text-stone-500 font-bold">
                                    {utm.clicks} <span className="font-normal text-stone-400">({percent}%)</span>
                                  </span>
                                </div>
                                <div className="h-1.5 w-full bg-stone-100 rounded-full overflow-hidden">
                                  <div
                                    className="h-full bg-amber-500 rounded-full"
                                    style={{ width: `${percent}%` }}
                                  />
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Per-Link Breakdown Table (when event-wide) */}
                  {traffic.linksBreakdown && traffic.linksBreakdown.length > 0 && (
                    <div className="p-4 rounded-xl bg-white border border-stone-200 shadow-2xs space-y-3">
                      <h6 className="font-display font-bold text-xs text-stone-900">
                        Performance Breakdown by Promotional Link
                      </h6>
                      <div className="overflow-x-auto">
                        <table className="w-full text-left text-xs border-collapse">
                          <thead>
                            <tr className="border-b border-stone-200 text-[10px] font-mono uppercase text-stone-500">
                              <th className="py-2 px-2">Link Name</th>
                              <th className="py-2 px-2">Type</th>
                              <th className="py-2 px-2">Primary Slug</th>
                              <th className="py-2 px-2 text-right">Total Clicks</th>
                              <th className="py-2 px-2 text-right">Unique Visitors</th>
                              <th className="py-2 px-2 text-right">Traffic Share</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-stone-100 font-mono text-[11px]">
                            {traffic.linksBreakdown.map((lb) => {
                              const share =
                                traffic.totalClicks > 0
                                  ? Math.round((lb.totalClicks / traffic.totalClicks) * 100)
                                  : 0;
                              return (
                                <tr key={lb.linkId} className="hover:bg-stone-50/50">
                                  <td className="py-2.5 px-2 font-sans font-medium text-stone-900">
                                    {lb.name}
                                  </td>
                                  <td className="py-2.5 px-2">
                                    {lb.type === 'CAMPAIGN' ? (
                                      <span className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase bg-purple-50 text-purple-700">
                                        Campaign
                                      </span>
                                    ) : (
                                      <span className="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase bg-amber-50 text-amber-800">
                                        Host
                                      </span>
                                    )}
                                  </td>
                                  <td className="py-2.5 px-2 text-stone-600">
                                    {lb.primarySlug ? `/r/${lb.primarySlug}` : '—'}
                                  </td>
                                  <td className="py-2.5 px-2 text-right font-bold text-stone-900">
                                    {lb.totalClicks.toLocaleString()}
                                  </td>
                                  <td className="py-2.5 px-2 text-right text-stone-700">
                                    {lb.uniqueVisitors.toLocaleString()}
                                  </td>
                                  <td className="py-2.5 px-2 text-right text-stone-500">
                                    {share}%
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="px-6 py-3 border-t border-stone-100 bg-[#FAF8F5] flex items-center justify-between text-[11px] font-mono text-stone-500">
          <span>
            {campaignCount} campaign link{campaignCount === 1 ? '' : 's'} · {hostCount} host link{hostCount === 1 ? '' : 's'}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="px-3.5 py-1 rounded-lg border border-stone-200 bg-white hover:bg-stone-50 text-stone-700 transition-colors cursor-pointer shadow-2xs font-medium"
          >
            Done
          </button>
        </div>
      </div>

      {/* =========================================================================
          DIALOG 1: CUSTOMIZE PRIMARY SLUG
         ========================================================================= */}
      {linkToCustomizeSlug && (
        <div className="fixed inset-0 z-60 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="max-w-md w-full bg-white rounded-2xl border border-stone-200 p-6 space-y-4 shadow-2xl">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-purple-50 text-purple-700 border border-purple-200 flex items-center justify-center">
                <Edit3 className="w-5 h-5" />
              </div>
              <div>
                <h3 className="font-display font-bold text-base text-stone-900">
                  Customize Primary Slug
                </h3>
                <span className="text-[11px] font-mono text-stone-500">
                  {linkToCustomizeSlug.name}
                </span>
              </div>
            </div>

            <form onSubmit={handleCustomizeSubmit} className="space-y-4">
              <div className="p-3 rounded-xl bg-stone-50 border border-stone-200 text-[11px] text-stone-600 space-y-1">
                <span className="font-semibold block text-stone-800">
                  Permanent Redirect Alias Guarantee:
                </span>
                <p className="leading-relaxed">
                  Your current slug (<strong className="font-mono text-stone-900">/r/{linkToCustomizeSlug.primarySlug}</strong>) will remain permanently reserved as a redirect alias. Any previously shared links will continue to route visitors seamlessly.
                </p>
              </div>

              {slugError && (
                <div className="p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
                  <span>{slugError}</span>
                </div>
              )}

              <div className="space-y-1.5">
                <label className="text-[11px] font-mono text-stone-600 uppercase font-semibold block">
                  New Primary Slug
                </label>
                <div className="relative">
                  <span className="text-xs font-mono text-stone-400 absolute left-3.5 top-1/2 -translate-y-1/2">
                    /r/
                  </span>
                  <input
                    type="text"
                    required
                    value={customSlugInput}
                    onChange={(e) => {
                      setCustomSlugInput(e.target.value);
                      setSlugError(null);
                    }}
                    placeholder="new-campaign-slug"
                    className="w-full pl-10 pr-4 py-2.5 rounded-xl border border-stone-200 text-xs font-mono text-stone-900 placeholder:text-stone-400 focus:outline-none focus:border-stone-900 shadow-2xs"
                  />
                </div>
                <span className="text-[10px] text-stone-400 font-mono block">
                  Must be 2-64 lowercase letters, numbers, and single hyphens.
                </span>
              </div>

              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => {
                    setLinkToCustomizeSlug(null);
                    setSlugError(null);
                  }}
                  disabled={customizeSlugMutation.isPending}
                  className="px-4 py-2 rounded-xl border border-stone-200 text-xs font-mono text-stone-600 hover:text-stone-900 hover:bg-stone-50 transition-colors shadow-2xs cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={customizeSlugMutation.isPending}
                  className="px-4 py-2 rounded-xl bg-stone-900 hover:bg-black text-white font-semibold text-xs font-mono uppercase tracking-wider transition-colors shadow-xs disabled:opacity-50 cursor-pointer"
                >
                  {customizeSlugMutation.isPending ? 'Saving Slug...' : 'Save Primary Slug'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* =========================================================================
          DIALOG 2: ARCHIVE LINK CONFIRMATION
         ========================================================================= */}
      {linkToArchive && (
        <div className="fixed inset-0 z-60 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="max-w-md w-full bg-white rounded-2xl border border-stone-200 p-6 space-y-4 shadow-2xl">
            <div className="flex items-center gap-3 text-rose-600">
              <div className="w-10 h-10 rounded-xl bg-rose-50 border border-rose-200 flex items-center justify-center">
                <Trash2 className="w-5 h-5 text-rose-600" />
              </div>
              <div>
                <h3 className="font-display font-bold text-base text-stone-900">
                  Archive Promotional Link?
                </h3>
                <span className="text-[11px] font-mono text-stone-500">
                  {linkToArchive.name}
                </span>
              </div>
            </div>

            <p className="text-xs text-stone-600 leading-relaxed">
              Are you sure you want to archive{' '}
              <strong className="text-stone-900">"{linkToArchive.name}"</strong>?
              Traffic through its slugs (/r/{linkToArchive.primarySlug}) will no longer be resolved. Historical click logs and analytics will be retained.
            </p>

            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setLinkToArchive(null)}
                disabled={updateLinkMutation.isPending}
                className="px-4 py-2 rounded-xl border border-stone-200 text-xs font-mono text-stone-600 hover:text-stone-900 hover:bg-stone-50 transition-colors shadow-2xs cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() =>
                  updateLinkMutation.mutate({
                    linkId: linkToArchive.id,
                    updates: { status: 'ARCHIVED' },
                  })
                }
                disabled={updateLinkMutation.isPending}
                className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-700 text-white font-semibold text-xs font-mono uppercase tracking-wider transition-colors shadow-xs disabled:opacity-50 cursor-pointer"
              >
                {updateLinkMutation.isPending ? 'Archiving...' : 'Confirm Archive'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
