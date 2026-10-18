import React, { useState, useEffect } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { EventCategory, TicketTierStatus } from '../types';
import {
  ArrowLeft,
  Save,
  Globe,
  Image as ImageIcon,
  Calendar,
  Ticket,
  Sliders,
  Eye,
  Plus,
  Trash2,
  Sparkles,
  CheckCircle2,
  AlertCircle,
  Upload,
  RefreshCw,
  X,
  MapPin,
  Lock,
} from 'lucide-react';

interface FormTicketTier {
  id?: string;
  tempId: string;
  name: string;
  description: string;
  price: number; // in USD (0 for free)
  totalCapacity: number;
  minPerOrder: number;
  maxPerOrder: number;
  salesStartAt: string;
  salesEndAt: string;
  status: TicketTierStatus;
  soldQuantity?: number;
}

const PRESET_COVERS = [
  {
    name: 'Baobab Stage',
    url: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?auto=format&fit=crop&w=1600&q=85',
  },
  {
    name: 'Industrial Rave',
    url: 'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?auto=format&fit=crop&w=1600&q=85',
  },
  {
    name: 'Coastal Sunset',
    url: 'https://images.unsplash.com/photo-1533174072545-7a4b6ad7a6c3?auto=format&fit=crop&w=1600&q=85',
  },
  {
    name: 'Sound System',
    url: 'https://images.unsplash.com/photo-1492684223066-81342ee5ff30?auto=format&fit=crop&w=1600&q=85',
  },
];

const KENYA_CITIES = ['Nairobi', 'Kilifi', 'Mombasa', 'Diani', 'Naivasha', 'Kisumu', 'Nakuru'];

const toInputValue = (dateString?: string | null) => {
  if (!dateString) return '';
  const d = new Date(dateString);
  if (isNaN(d.getTime())) return '';
  const pad = (n: number) => n.toString().padStart(2, '0');
  const YYYY = d.getFullYear();
  const MM = pad(d.getMonth() + 1);
  const DD = pad(d.getDate());
  const hh = pad(d.getHours());
  const mm = pad(d.getMinutes());
  return `${YYYY}-${MM}-${DD}T${hh}:${mm}`;
};

const toIsoValue = (localString?: string | null) => {
  if (!localString) return null;
  const d = new Date(localString);
  if (isNaN(d.getTime())) return null;
  return d.toISOString();
};

export const CreateEventPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const isEditing = Boolean(id);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user, quickLoginAs } = useAuth();

  const [activeSection, setActiveSection] = useState<
    'details' | 'schedule' | 'venue' | 'artwork' | 'tickets' | 'policies' | 'preview'
  >('details');

  // Form State
  const [title, setTitle] = useState('');
  const [tagline, setTagline] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<EventCategory>('MUSIC');
  const [coverImageUrl, setCoverImageUrl] = useState(PRESET_COVERS[0].url);

  const [startAt, setStartAt] = useState('2026-11-20T20:00');
  const [endAt, setEndAt] = useState('2026-11-21T04:00');
  const [timezone, setTimezone] = useState('Africa/Nairobi');

  const [venueName, setVenueName] = useState('');
  const [venueAddress, setVenueAddress] = useState('');
  const [city, setCity] = useState('Nairobi');
  const [country, setCountry] = useState('Kenya');

  const [ageRestriction, setAgeRestriction] = useState('18+');
  const [dressCode, setDressCode] = useState('');
  const [doorPolicy, setDoorPolicy] = useState('');

  const [currentStatus, setCurrentStatus] = useState<'DRAFT' | 'PUBLISHED'>('DRAFT');
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

  const [ticketTiers, setTicketTiers] = useState<FormTicketTier[]>([
    {
      tempId: 'default-1',
      name: 'Early Bird General Admission',
      description: 'Standard festival entrance with early arrival benefits before 10 PM.',
      price: 25,
      totalCapacity: 250,
      minPerOrder: 1,
      maxPerOrder: 6,
      salesStartAt: '',
      salesEndAt: '',
      status: 'ACTIVE',
    },
    {
      tempId: 'default-2',
      name: 'VIP Deck & Lounge',
      description: 'Expedited admission line, elevated sound deck, and complimentary welcome drink.',
      price: 75,
      totalCapacity: 100,
      minPerOrder: 1,
      maxPerOrder: 4,
      salesStartAt: '',
      salesEndAt: '',
      status: 'ACTIVE',
    },
  ]);

  const [notification, setNotification] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  const showNotification = (type: 'success' | 'error', message: string) => {
    setNotification({ type, message });
    setTimeout(() => setNotification(null), 5000);
  };

  // Fetch existing event if editing
  const { data: existingData, isLoading: isLoadingExisting } = useQuery({
    queryKey: ['organizer-event', id],
    queryFn: () => api.organizer.getEvent(id!),
    enabled: isEditing,
  });

  useEffect(() => {
    if (existingData?.event) {
      const evt = existingData.event;
      setTitle(evt.title);
      setTagline(evt.tagline || '');
      setDescription(evt.description || '');
      setCategory(evt.category);
      setCoverImageUrl(evt.coverImageUrl);
      setStartAt(toInputValue(evt.startAt));
      setEndAt(toInputValue(evt.endAt));
      setTimezone(evt.timezone || 'Africa/Nairobi');
      setVenueName(evt.venueName || '');
      setVenueAddress(evt.venueAddress || '');
      setCity(evt.city || 'Nairobi');
      setCountry(evt.country || 'Kenya');
      setAgeRestriction(evt.ageRestriction || '18+');
      setDressCode(evt.dressCode || '');
      setCurrentStatus(evt.status as 'DRAFT' | 'PUBLISHED');

      if (evt.ticketTiers && evt.ticketTiers.length > 0) {
        setTicketTiers(
          evt.ticketTiers.map((tier) => ({
            id: tier.id,
            tempId: tier.id,
            name: tier.name,
            description: tier.description || '',
            price: tier.priceInCents / 100,
            totalCapacity: tier.totalCapacity,
            minPerOrder: tier.minPerOrder,
            maxPerOrder: tier.maxPerOrder,
            salesStartAt: toInputValue(tier.salesStartAt),
            salesEndAt: toInputValue(tier.salesEndAt),
            status: tier.status,
            soldQuantity: tier.soldQuantity,
          }))
        );
      }
      setHasUnsavedChanges(false);
    }
  }, [existingData]);

  // Ticket tier actions
  const addTicketTier = () => {
    setTicketTiers((prev) => [
      ...prev,
      {
        tempId: Math.random().toString(36).substring(7),
        name: 'General Admission',
        description: 'Standard event entry pass.',
        price: 40,
        totalCapacity: 300,
        minPerOrder: 1,
        maxPerOrder: 6,
        salesStartAt: '',
        salesEndAt: '',
        status: 'ACTIVE',
      },
    ]);
    setHasUnsavedChanges(true);
  };

  const removeTicketTier = (tempId: string) => {
    const tier = ticketTiers.find((t) => t.tempId === tempId);
    if (tier && tier.soldQuantity && tier.soldQuantity > 0) {
      showNotification(
        'error',
        `Tier "${tier.name}" already has ${tier.soldQuantity} ticket sale(s) and cannot be deleted. You can mark it as HIDDEN or PAUSED instead.`
      );
      return;
    }
    if (ticketTiers.length <= 1) {
      showNotification('error', 'An event must have at least one ticket tier.');
      return;
    }
    setTicketTiers((prev) => prev.filter((t) => t.tempId !== tempId));
    setHasUnsavedChanges(true);
  };

  const updateTier = (tempId: string, field: keyof FormTicketTier, value: any) => {
    setTicketTiers((prev) =>
      prev.map((tier) => (tier.tempId === tempId ? { ...tier, [field]: value } : tier))
    );
    setHasUnsavedChanges(true);
  };

  // Image Upload handler (File Reader Data URL)
  const handleImageFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      showNotification('error', 'Please upload a valid image file (JPEG, PNG, WebP).');
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      showNotification('error', 'Image size must be under 5MB.');
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setCoverImageUrl(reader.result);
        setHasUnsavedChanges(true);
        showNotification('success', 'Artwork uploaded successfully and ready for preview.');
      }
    };
    reader.onerror = () => {
      showNotification('error', 'Failed to read image file.');
    };
    reader.readAsDataURL(file);
  };

  // Build Payload
  const buildPayload = (statusOverride?: 'DRAFT' | 'PUBLISHED') => {
    const formattedTiers = ticketTiers.map((tier) => ({
      ...(tier.id ? { id: tier.id } : {}),
      name: tier.name.trim() || 'General Admission',
      description: tier.description.trim() || null,
      priceInCents: Math.round((Number(tier.price) || 0) * 100),
      currency: 'USD',
      totalCapacity: Math.max(1, Number(tier.totalCapacity) || 1),
      minPerOrder: Math.max(1, Number(tier.minPerOrder) || 1),
      maxPerOrder: Math.max(
        Math.max(1, Number(tier.minPerOrder) || 1),
        Number(tier.maxPerOrder) || 1
      ),
      salesStartAt: toIsoValue(tier.salesStartAt),
      salesEndAt: toIsoValue(tier.salesEndAt),
      status: tier.status,
    }));

    const fullDescription = doorPolicy.trim() && !description.includes(doorPolicy.trim())
      ? (description.trim() ? `${description.trim()}\n\nDoor Policy: ${doorPolicy.trim()}` : `Door Policy: ${doorPolicy.trim()}`)
      : description.trim();

    return {
      title: title.trim() || 'Untitled Experience Draft',
      tagline: tagline.trim() || null,
      description: fullDescription,
      category,
      coverImageUrl: coverImageUrl.trim(),
      venueName: venueName.trim() || '',
      venueAddress: venueAddress.trim() || '',
      city: city.trim() || 'Nairobi',
      country: country.trim() || 'Kenya',
      startAt: toIsoValue(startAt) || new Date().toISOString(),
      endAt: toIsoValue(endAt) || new Date(Date.now() + 86400000).toISOString(),
      timezone,
      ageRestriction: ageRestriction || '18+',
      dressCode: dressCode.trim() || null,
      status: statusOverride || currentStatus,
      ticketTiers: formattedTiers,
    };
  };

  // Mutations
  const saveMutation = useMutation({
    mutationFn: async ({ publish }: { publish: boolean }) => {
      // Validate date times
      const startMs = new Date(startAt).getTime();
      const endMs = new Date(endAt).getTime();
      if (endMs <= startMs) {
        throw new Error('Event end time must be after the start time.');
      }

      if (publish) {
        if (!title.trim() || title.trim().length < 2) {
          throw new Error('Event title must be at least 2 characters long to publish.');
        }
        if (!venueName.trim()) {
          throw new Error('Venue name is required before publishing.');
        }
        if (!city.trim()) {
          throw new Error('City is required before publishing.');
        }
        if (!coverImageUrl.trim()) {
          throw new Error('Cover artwork image is required before publishing.');
        }
        if (ticketTiers.length === 0) {
          throw new Error('At least one ticket tier is required to publish.');
        }
      }

      const payload = buildPayload(publish ? 'PUBLISHED' : undefined);

      let savedEventId = id;
      if (isEditing && id) {
        const res = await api.organizer.updateEvent(id, payload);
        savedEventId = res.event.id;
        if (publish && res.event.status !== 'PUBLISHED') {
          await api.organizer.publishEvent(savedEventId);
        }
      } else {
        const res = await api.organizer.createEvent(payload);
        savedEventId = res.event.id;
        if (publish) {
          await api.organizer.publishEvent(savedEventId);
        }
      }

      return { eventId: savedEventId, published: publish };
    },
    onSuccess: ({ eventId, published }) => {
      setHasUnsavedChanges(false);
      queryClient.invalidateQueries({ queryKey: ['organizer-dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['organizer-events'] });
      queryClient.invalidateQueries({ queryKey: ['organizer-event', eventId] });
      queryClient.invalidateQueries({ queryKey: ['events'] });

      showNotification(
        'success',
        published
          ? 'Event published live to Outside.vip discovery!'
          : 'Event draft saved to PostgreSQL database.'
      );

      if (!isEditing && eventId) {
        navigate(`/organizer/events/${eventId}/edit`, { replace: true });
      } else if (published) {
        setCurrentStatus('PUBLISHED');
      }
    },
    onError: (err: any) => {
      showNotification('error', err?.message || 'Failed to save event. Check fields and try again.');
    },
  });

  const unpublishMutation = useMutation({
    mutationFn: async () => {
      if (!id) return;
      return api.organizer.unpublishEvent(id);
    },
    onSuccess: () => {
      setCurrentStatus('DRAFT');
      queryClient.invalidateQueries({ queryKey: ['organizer-dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['organizer-events'] });
      queryClient.invalidateQueries({ queryKey: ['organizer-event', id] });
      queryClient.invalidateQueries({ queryKey: ['events'] });
      showNotification('success', 'Event reverted to draft status. Hidden from discovery.');
    },
    onError: (err: any) => {
      showNotification('error', err?.message || 'Failed to unpublish event.');
    },
  });

  // Auth gate
  if (!user || (user.role !== 'ORGANIZER' && user.role !== 'ADMIN')) {
    return (
      <div className="min-h-screen bg-[#08090C] text-white flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-[#0E1015] border border-white/10 rounded-2xl p-8 space-y-4 text-center">
          <Lock className="w-10 h-10 text-[#D2FF00] mx-auto" />
          <h2 className="font-display font-bold text-xl text-white">Organizer Access Required</h2>
          <p className="text-xs text-gray-400">
            Sign in as an event organizer to create and edit experiences.
          </p>
          <button
            onClick={() => quickLoginAs('organizer')}
            className="w-full py-2.5 rounded-xl bg-[#D2FF00] hover:bg-[#BEF200] text-black font-semibold text-xs font-mono uppercase tracking-wider"
          >
            Sign in as Sol Collective (Demo)
          </button>
        </div>
      </div>
    );
  }

  if (isEditing && isLoadingExisting) {
    return (
      <div className="min-h-screen bg-[#08090C] text-white flex items-center justify-center p-4">
        <div className="flex items-center gap-3 text-xs font-mono text-gray-400">
          <RefreshCw className="w-5 h-5 animate-spin text-[#D2FF00]" />
          Loading experience draft...
        </div>
      </div>
    );
  }

  const generatedSlugPreview = title.trim()
    ? title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)+/g, '')
    : 'event-slug';

  return (
    <div className="min-h-screen bg-[#08090C] text-gray-100 selection:bg-[#D2FF00] selection:text-black pb-36">
      {/* Sticky Editor Command Bar */}
      <div className="sticky top-0 z-40 bg-[#08090C]/95 backdrop-blur-md border-b border-white/10 shadow-2xl">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 sm:gap-4 min-w-0">
            <Link
              to="/organizer"
              className="p-2 rounded-xl bg-[#14171F] hover:bg-[#1C202B] text-gray-400 hover:text-white border border-white/10 transition-colors shrink-0"
              title="Return to Organizer Dashboard"
            >
              <ArrowLeft className="w-4 h-4" />
            </Link>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-display font-bold text-sm sm:text-base text-white truncate max-w-[180px] sm:max-w-md">
                  {title || 'Untitled Experience'}
                </span>
                {currentStatus === 'PUBLISHED' ? (
                  <span className="px-2 py-0.5 rounded text-[10px] font-mono uppercase bg-[#D2FF00]/10 text-[#D2FF00] border border-[#D2FF00]/30 font-bold shrink-0">
                    Live
                  </span>
                ) : (
                  <span className="px-2 py-0.5 rounded text-[10px] font-mono uppercase bg-amber-400/10 text-amber-300 border border-amber-400/30 font-bold shrink-0">
                    Draft
                  </span>
                )}
                {hasUnsavedChanges && (
                  <span className="text-[10px] font-mono text-gray-400 italic hidden md:inline">
                    • Unsaved changes
                  </span>
                )}
              </div>
              <span className="text-[11px] text-gray-500 font-mono hidden sm:block truncate">
                outside.vip/events/{generatedSlugPreview}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
            {/* Preview Button */}
            {id && (
              <Link
                to={`/organizer/events/${id}/preview`}
                className="hidden sm:inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-[#14171F] hover:bg-[#1C202B] text-gray-300 hover:text-white border border-white/10 text-xs font-mono transition-colors"
                title="Preview Event in Public Layout"
              >
                <Eye className="w-3.5 h-3.5 text-gray-400" />
                <span>Preview</span>
              </Link>
            )}

            {/* Save Draft */}
            <button
              type="button"
              onClick={() => saveMutation.mutate({ publish: false })}
              disabled={saveMutation.isPending}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-[#14171F] hover:bg-[#1C202B] text-gray-200 hover:text-white border border-white/10 text-xs font-mono font-semibold transition-colors disabled:opacity-50"
            >
              <Save className="w-3.5 h-3.5 text-gray-400" />
              <span>{saveMutation.isPending ? 'Saving...' : 'Save Draft'}</span>
            </button>

            {/* Publish or Unpublish */}
            {currentStatus === 'PUBLISHED' ? (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => unpublishMutation.mutate()}
                  disabled={unpublishMutation.isPending}
                  className="px-3 py-2 rounded-xl bg-amber-400/10 hover:bg-amber-400/20 text-amber-300 border border-amber-400/30 text-xs font-mono font-semibold transition-colors disabled:opacity-50"
                >
                  Unpublish
                </button>
                <button
                  type="button"
                  onClick={() => saveMutation.mutate({ publish: false })}
                  disabled={saveMutation.isPending}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#D2FF00] hover:bg-[#BEF200] text-black font-semibold text-xs font-mono uppercase tracking-wider transition-all duration-200 shadow-[0_0_15px_rgba(210,255,0,0.2)] disabled:opacity-50"
                >
                  Update Live
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => saveMutation.mutate({ publish: true })}
                disabled={saveMutation.isPending}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#D2FF00] hover:bg-[#BEF200] text-black font-semibold text-xs font-mono uppercase tracking-wider transition-all duration-200 shadow-[0_0_20px_rgba(210,255,0,0.25)] disabled:opacity-50"
              >
                <Globe className="w-3.5 h-3.5" />
                <span>{saveMutation.isPending ? 'Publishing...' : 'Publish Live'}</span>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Toast Notification */}
      {notification && (
        <div className="max-w-7xl mx-auto px-4 mt-6">
          <div
            className={`p-4 rounded-xl border text-xs font-medium flex items-center justify-between gap-3 ${
              notification.type === 'success'
                ? 'bg-[#0E1015] border-[#D2FF00]/40 text-[#D2FF00]'
                : 'bg-[#0E1015] border-rose-500/40 text-rose-300'
            }`}
          >
            <div className="flex items-center gap-2">
              {notification.type === 'success' ? (
                <CheckCircle2 className="w-5 h-5 text-[#D2FF00] shrink-0" />
              ) : (
                <AlertCircle className="w-5 h-5 text-rose-400 shrink-0" />
              )}
              <span>{notification.message}</span>
            </div>
            <button onClick={() => setNotification(null)} className="text-gray-400 hover:text-white">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Editor Main Body */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 mt-8">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          {/* Section Navigation Tabs Sidebar */}
          <aside className="lg:col-span-3 space-y-1.5 lg:sticky lg:top-24">
            <div className="text-[11px] font-mono uppercase tracking-wider text-gray-400 font-bold px-3 py-1">
              Configuration Steps
            </div>

            {[
              { id: 'details', label: '1. Basic Information', icon: Sparkles },
              { id: 'schedule', label: '2. Date & Schedule', icon: Calendar },
              { id: 'venue', label: '3. Venue & Location', icon: MapPin },
              { id: 'artwork', label: '4. Artwork & Cover Flyer', icon: ImageIcon },
              { id: 'tickets', label: '5. Ticket Tiers & Capacity', icon: Ticket },
              { id: 'policies', label: '6. Policies & Door Rules', icon: Sliders },
              { id: 'preview', label: '7. Live Discovery Card Preview', icon: Eye },
            ].map((section) => {
              const Icon = section.icon;
              const isActive = activeSection === section.id;
              return (
                <button
                  key={section.id}
                  onClick={() => setActiveSection(section.id as any)}
                  className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-mono transition-colors text-left ${
                    isActive
                      ? 'bg-[#14171F] text-[#D2FF00] font-bold border border-[#D2FF00]/30 shadow-lg'
                      : 'text-gray-400 hover:text-white hover:bg-white/[0.04] border border-transparent'
                  }`}
                >
                  <Icon className={`w-4 h-4 ${isActive ? 'text-[#D2FF00]' : 'text-gray-500'}`} />
                  <span>{section.label}</span>
                </button>
              );
            })}

            {/* Quick summary box */}
            <div className="pt-4 mt-4 border-t border-white/10 px-3 space-y-2 text-[11px] font-mono text-gray-500">
              <div className="flex justify-between">
                <span>Configured Tiers:</span>
                <span className="text-white font-bold">{ticketTiers.length}</span>
              </div>
              <div className="flex justify-between">
                <span>Total Capacity:</span>
                <span className="text-white font-bold">
                  {ticketTiers.reduce((acc, t) => acc + (Number(t.totalCapacity) || 0), 0)}
                </span>
              </div>
              <div className="flex justify-between">
                <span>Min Price:</span>
                <span className="text-emerald-400 font-bold">
                  ${Math.min(...ticketTiers.map((t) => Number(t.price) || 0))}
                </span>
              </div>
            </div>
          </aside>

          {/* Form Content Area */}
          <main className="lg:col-span-9 space-y-6">
            {/* 1. Basic Information */}
            {activeSection === 'details' && (
              <div className="bg-[#0E1015] rounded-2xl border border-white/10 p-6 sm:p-8 space-y-6 shadow-2xl">
                <div>
                  <h2 className="text-lg sm:text-xl font-display font-bold text-white">
                    Basic Information & Narrative
                  </h2>
                  <p className="text-xs text-gray-400 mt-0.5">
                    Establish your event's headline, editorial story, and category for discovery filters.
                  </p>
                </div>

                <div className="space-y-4">
                  <div>
                    <label className="block text-xs font-mono uppercase text-gray-300 font-semibold mb-1.5">
                      Event Title <span className="text-[#D2FF00]">*</span>
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. SOL FEST: Under The Baobab Tree"
                      value={title}
                      onChange={(e) => {
                        setTitle(e.target.value);
                        setHasUnsavedChanges(true);
                      }}
                      className="w-full px-4 py-2.5 rounded-xl bg-[#14171F] border border-white/10 text-white placeholder-gray-500 text-sm focus:outline-none focus:border-[#D2FF00] transition-colors"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-mono uppercase text-gray-300 font-semibold mb-1.5">
                      Editorial Tagline
                    </label>
                    <input
                      type="text"
                      placeholder="A short, evocative sentence describing the sound, atmosphere, or headliners"
                      value={tagline}
                      onChange={(e) => {
                        setTagline(e.target.value);
                        setHasUnsavedChanges(true);
                      }}
                      className="w-full px-4 py-2.5 rounded-xl bg-[#14171F] border border-white/10 text-white placeholder-gray-500 text-sm focus:outline-none focus:border-[#D2FF00] transition-colors"
                    />
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-mono uppercase text-gray-300 font-semibold mb-1.5">
                        Category
                      </label>
                      <select
                        value={category}
                        onChange={(e) => {
                          setCategory(e.target.value as EventCategory);
                          setHasUnsavedChanges(true);
                        }}
                        className="w-full px-4 py-2.5 rounded-xl bg-[#14171F] border border-white/10 text-white text-sm focus:outline-none focus:border-[#D2FF00] transition-colors cursor-pointer"
                      >
                        <option value="MUSIC">Live Music</option>
                        <option value="FESTIVAL">Festival</option>
                        <option value="NIGHTLIFE">Nightlife & Rave</option>
                        <option value="TECH">Tech Summit</option>
                        <option value="ARTS_CULTURE">Arts & Culture</option>
                        <option value="FOOD_DRINK">Food & Drink</option>
                        <option value="SPORTS">Sports & Outdoor</option>
                        <option value="COMMUNITY">Community</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-xs font-mono uppercase text-gray-300 font-semibold mb-1.5">
                        Generated Slug Preview
                      </label>
                      <div className="w-full px-4 py-2.5 rounded-xl bg-[#14171F]/50 border border-white/5 text-gray-400 font-mono text-xs flex items-center justify-between">
                        <span className="truncate">/{generatedSlugPreview}</span>
                        <span className="text-[10px] uppercase text-[#D2FF00] bg-[#D2FF00]/10 px-1.5 py-0.5 rounded">
                          Auto-Managed
                        </span>
                      </div>
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-mono uppercase text-gray-300 font-semibold mb-1.5">
                      Full Description & Experience Details
                    </label>
                    <textarea
                      rows={6}
                      placeholder="Lineup, stage schedule, immersive installations, curated mixology, audio architecture, parking details..."
                      value={description}
                      onChange={(e) => {
                        setDescription(e.target.value);
                        setHasUnsavedChanges(true);
                      }}
                      className="w-full px-4 py-2.5 rounded-xl bg-[#14171F] border border-white/10 text-white placeholder-gray-500 text-sm focus:outline-none focus:border-[#D2FF00] transition-colors leading-relaxed"
                    />
                  </div>
                </div>
              </div>
            )}

            {/* 2. Date & Schedule */}
            {activeSection === 'schedule' && (
              <div className="bg-[#0E1015] rounded-2xl border border-white/10 p-6 sm:p-8 space-y-6 shadow-2xl">
                <div>
                  <h2 className="text-lg sm:text-xl font-display font-bold text-white">
                    Date & Schedule
                  </h2>
                  <p className="text-xs text-gray-400 mt-0.5">
                    Define start and conclusion times. Nairobi (EAT) is default.
                  </p>
                </div>

                <div className="space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-mono uppercase text-gray-300 font-semibold mb-1.5">
                        Starts At <span className="text-[#D2FF00]">*</span>
                      </label>
                      <input
                        type="datetime-local"
                        value={startAt}
                        onChange={(e) => {
                          setStartAt(e.target.value);
                          setHasUnsavedChanges(true);
                        }}
                        className="w-full px-4 py-2.5 rounded-xl bg-[#14171F] border border-white/10 text-white text-sm focus:outline-none focus:border-[#D2FF00] transition-colors"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-mono uppercase text-gray-300 font-semibold mb-1.5">
                        Ends At <span className="text-[#D2FF00]">*</span>
                      </label>
                      <input
                        type="datetime-local"
                        value={endAt}
                        onChange={(e) => {
                          setEndAt(e.target.value);
                          setHasUnsavedChanges(true);
                        }}
                        className="w-full px-4 py-2.5 rounded-xl bg-[#14171F] border border-white/10 text-white text-sm focus:outline-none focus:border-[#D2FF00] transition-colors"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-mono uppercase text-gray-300 font-semibold mb-1.5">
                      Event Timezone
                    </label>
                    <select
                      value={timezone}
                      onChange={(e) => {
                        setTimezone(e.target.value);
                        setHasUnsavedChanges(true);
                      }}
                      className="w-full px-4 py-2.5 rounded-xl bg-[#14171F] border border-white/10 text-white text-sm focus:outline-none focus:border-[#D2FF00] transition-colors cursor-pointer"
                    >
                      <option value="Africa/Nairobi">Africa/Nairobi (EAT, UTC+3)</option>
                      <option value="Africa/Cairo">Africa/Cairo (EET, UTC+2)</option>
                      <option value="Africa/Johannesburg">Africa/Johannesburg (SAST, UTC+2)</option>
                      <option value="Europe/London">Europe/London (GMT/BST)</option>
                      <option value="America/New_York">America/New_York (EST/EDT)</option>
                    </select>
                  </div>
                </div>
              </div>
            )}

            {/* 3. Venue & Location */}
            {activeSection === 'venue' && (
              <div className="bg-[#0E1015] rounded-2xl border border-white/10 p-6 sm:p-8 space-y-6 shadow-2xl">
                <div>
                  <h2 className="text-lg sm:text-xl font-display font-bold text-white">
                    Venue & Location
                  </h2>
                  <p className="text-xs text-gray-400 mt-0.5">
                    Physical venue and directions for Kenya navigators.
                  </p>
                </div>

                <div className="space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-mono uppercase text-gray-300 font-semibold mb-1.5">
                        Venue / Location Name <span className="text-[#D2FF00]">*</span>
                      </label>
                      <input
                        type="text"
                        placeholder="e.g. The Baobab Amphitheatre"
                        value={venueName}
                        onChange={(e) => {
                          setVenueName(e.target.value);
                          setHasUnsavedChanges(true);
                        }}
                        className="w-full px-4 py-2.5 rounded-xl bg-[#14171F] border border-white/10 text-white placeholder-gray-500 text-sm focus:outline-none focus:border-[#D2FF00] transition-colors"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-mono uppercase text-gray-300 font-semibold mb-1.5">
                        City / Destination <span className="text-[#D2FF00]">*</span>
                      </label>
                      <input
                        type="text"
                        placeholder="Nairobi, Kilifi, Mombasa..."
                        value={city}
                        onChange={(e) => {
                          setCity(e.target.value);
                          setHasUnsavedChanges(true);
                        }}
                        className="w-full px-4 py-2.5 rounded-xl bg-[#14171F] border border-white/10 text-white placeholder-gray-500 text-sm focus:outline-none focus:border-[#D2FF00] transition-colors"
                      />
                      {/* Kenya Quick Pick Chips */}
                      <div className="flex flex-wrap gap-1.5 mt-2">
                        {KENYA_CITIES.map((c) => (
                          <button
                            key={c}
                            type="button"
                            onClick={() => {
                              setCity(c);
                              setHasUnsavedChanges(true);
                            }}
                            className={`px-2 py-0.5 rounded text-[10px] font-mono transition-colors ${
                              city === c
                                ? 'bg-[#D2FF00] text-black font-bold'
                                : 'bg-white/5 hover:bg-white/10 text-gray-400'
                            }`}
                          >
                            {c}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-mono uppercase text-gray-300 font-semibold mb-1.5">
                      Physical Address & Landmarks
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. Bofa Beach Road, Kilifi Creek Crossing"
                      value={venueAddress}
                      onChange={(e) => {
                        setVenueAddress(e.target.value);
                        setHasUnsavedChanges(true);
                      }}
                      className="w-full px-4 py-2.5 rounded-xl bg-[#14171F] border border-white/10 text-white placeholder-gray-500 text-sm focus:outline-none focus:border-[#D2FF00] transition-colors"
                    />
                  </div>
                </div>
              </div>
            )}

            {/* 4. Artwork & Flyer */}
            {activeSection === 'artwork' && (
              <div className="bg-[#0E1015] rounded-2xl border border-white/10 p-6 sm:p-8 space-y-6 shadow-2xl">
                <div>
                  <h2 className="text-lg sm:text-xl font-display font-bold text-white">
                    Artwork & Visual Identity
                  </h2>
                  <p className="text-xs text-gray-400 mt-0.5">
                    High resolution cover artwork or event poster (16:9 or 16:10 aspect ratio recommended).
                  </p>
                </div>

                <div className="space-y-5">
                  {/* Upload or URL input */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-mono uppercase text-gray-300 font-semibold mb-1.5">
                        Direct Cover URL
                      </label>
                      <input
                        type="url"
                        placeholder="https://..."
                        value={coverImageUrl}
                        onChange={(e) => {
                          setCoverImageUrl(e.target.value);
                          setHasUnsavedChanges(true);
                        }}
                        className="w-full px-4 py-2.5 rounded-xl bg-[#14171F] border border-white/10 text-white placeholder-gray-500 text-xs focus:outline-none focus:border-[#D2FF00] transition-colors font-mono"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-mono uppercase text-gray-300 font-semibold mb-1.5">
                        Upload Flyer File (Max 5MB)
                      </label>
                      <label className="w-full px-4 py-2.5 rounded-xl bg-[#14171F] border border-dashed border-white/20 hover:border-[#D2FF00] text-gray-300 hover:text-white text-xs font-mono flex items-center justify-center gap-2 cursor-pointer transition-colors">
                        <Upload className="w-4 h-4 text-[#D2FF00]" />
                        <span>Choose Local Image File</span>
                        <input
                          type="file"
                          accept="image/*"
                          onChange={handleImageFileChange}
                          className="hidden"
                        />
                      </label>
                    </div>
                  </div>

                  {/* Preset Quick Select */}
                  <div>
                    <span className="text-[11px] font-mono text-gray-400 block mb-2">
                      Or select from curated Outside.vip event aesthetics:
                    </span>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      {PRESET_COVERS.map((preset) => (
                        <button
                          key={preset.name}
                          type="button"
                          onClick={() => {
                            setCoverImageUrl(preset.url);
                            setHasUnsavedChanges(true);
                          }}
                          className={`p-2 rounded-xl border text-left space-y-1.5 transition-all ${
                            coverImageUrl === preset.url
                              ? 'bg-[#14171F] border-[#D2FF00] ring-1 ring-[#D2FF00]'
                              : 'bg-[#14171F]/50 border-white/10 hover:border-white/20'
                          }`}
                        >
                          <div className="aspect-[16/10] rounded-lg overflow-hidden bg-black/40">
                            <img
                              src={preset.url}
                              alt={preset.name}
                              className="w-full h-full object-cover"
                            />
                          </div>
                          <span className="text-[11px] font-mono text-gray-300 block truncate">
                            {preset.name}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Artwork Live Preview */}
                  {coverImageUrl && (
                    <div className="space-y-2">
                      <span className="text-xs font-mono text-gray-400">Current Artwork Preview:</span>
                      <div className="relative aspect-[16/9] rounded-2xl overflow-hidden bg-[#14171F] border border-white/10 max-w-2xl">
                        <img
                          src={coverImageUrl}
                          alt="Cover Preview"
                          className="w-full h-full object-cover"
                        />
                        <div className="absolute bottom-3 right-3 px-3 py-1 rounded-lg bg-black/80 backdrop-blur-md text-[11px] font-mono text-[#D2FF00] border border-white/10">
                          Active Flyer Preview
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* 5. Ticket Tiers & Capacity */}
            {activeSection === 'tickets' && (
              <div className="bg-[#0E1015] rounded-2xl border border-white/10 p-6 sm:p-8 space-y-6 shadow-2xl">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div>
                    <h2 className="text-lg sm:text-xl font-display font-bold text-white">
                      Ticket Tiers & Inventory Management
                    </h2>
                    <p className="text-xs text-gray-400 mt-0.5">
                      Configure prices, capacity, per-order limits, and sales windows. Free tickets ($0) supported.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={addTicketTier}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-[#D2FF00] hover:bg-[#BEF200] text-black font-semibold text-xs font-mono uppercase tracking-wider transition-all duration-200 shadow-[0_0_15px_rgba(210,255,0,0.2)] shrink-0"
                  >
                    <Plus className="w-4 h-4" />
                    Add Tier
                  </button>
                </div>

                <div className="space-y-4">
                  {ticketTiers.map((tier, index) => {
                    const hasSales = (tier.soldQuantity || 0) > 0;
                    return (
                      <div
                        key={tier.tempId}
                        className="p-5 rounded-2xl bg-[#14171F] border border-white/10 space-y-4"
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span className="w-5 h-5 rounded-full bg-[#D2FF00]/10 border border-[#D2FF00]/30 flex items-center justify-center text-[10px] font-mono font-bold text-[#D2FF00]">
                              {index + 1}
                            </span>
                            <span className="text-xs font-mono text-white font-bold uppercase tracking-wider">
                              {tier.name || `Tier #${index + 1}`}
                            </span>
                            {hasSales && (
                              <span className="px-2 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[10px] font-mono">
                                {tier.soldQuantity} Sold
                              </span>
                            )}
                          </div>

                          <div className="flex items-center gap-2">
                            {/* Status Toggle */}
                            <select
                              value={tier.status}
                              onChange={(e) =>
                                updateTier(tier.tempId, 'status', e.target.value as TicketTierStatus)
                              }
                              className="px-2 py-1 rounded-lg bg-[#0E1015] border border-white/10 text-[11px] font-mono text-gray-300 focus:outline-none"
                            >
                              <option value="ACTIVE">ACTIVE</option>
                              <option value="PAUSED">PAUSED</option>
                              <option value="HIDDEN">HIDDEN</option>
                            </select>

                            {/* Remove button */}
                            {ticketTiers.length > 1 && (
                              <button
                                type="button"
                                onClick={() => removeTicketTier(tier.tempId)}
                                className={`p-1.5 rounded-lg text-gray-400 hover:text-rose-400 hover:bg-rose-950/30 transition-colors ${
                                  hasSales ? 'opacity-40 cursor-not-allowed' : ''
                                }`}
                                title={
                                  hasSales
                                    ? 'Cannot delete tier with existing sales'
                                    : 'Remove ticket tier'
                                }
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            )}
                          </div>
                        </div>

                        {/* Fields Row 1: Name & Price */}
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                          <div className="sm:col-span-2">
                            <label className="block text-[11px] font-mono uppercase text-gray-400 mb-1">
                              Tier Name <span className="text-[#D2FF00]">*</span>
                            </label>
                            <input
                              type="text"
                              value={tier.name}
                              onChange={(e) => updateTier(tier.tempId, 'name', e.target.value)}
                              placeholder="e.g. VIP Backstage Pass"
                              className="w-full px-3 py-2 rounded-xl bg-[#0E1015] border border-white/10 text-white text-xs focus:outline-none focus:border-[#D2FF00]"
                            />
                          </div>

                          <div>
                            <label className="block text-[11px] font-mono uppercase text-gray-400 mb-1">
                              Price (USD) <span className="text-[#D2FF00]">*</span>
                            </label>
                            <div className="relative">
                              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 font-mono text-xs">
                                $
                              </span>
                              <input
                                type="number"
                                min="0"
                                step="1"
                                value={tier.price}
                                onChange={(e) =>
                                  updateTier(
                                    tier.tempId,
                                    'price',
                                    Math.max(0, parseFloat(e.target.value) || 0)
                                  )
                                }
                                className="w-full pl-7 pr-3 py-2 rounded-xl bg-[#0E1015] border border-white/10 text-white text-xs font-mono focus:outline-none focus:border-[#D2FF00]"
                              />
                            </div>
                          </div>
                        </div>

                        {/* Fields Row 2: Capacity, Min, Max */}
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                          <div>
                            <label className="block text-[11px] font-mono uppercase text-gray-400 mb-1">
                              Total Capacity <span className="text-[#D2FF00]">*</span>
                            </label>
                            <input
                              type="number"
                              min="1"
                              value={tier.totalCapacity}
                              onChange={(e) =>
                                updateTier(
                                  tier.tempId,
                                  'totalCapacity',
                                  Math.max(1, parseInt(e.target.value, 10) || 1)
                                )
                              }
                              className="w-full px-3 py-2 rounded-xl bg-[#0E1015] border border-white/10 text-white text-xs font-mono focus:outline-none focus:border-[#D2FF00]"
                            />
                          </div>

                          <div>
                            <label className="block text-[11px] font-mono uppercase text-gray-400 mb-1">
                              Min Per Order
                            </label>
                            <input
                              type="number"
                              min="1"
                              value={tier.minPerOrder}
                              onChange={(e) =>
                                updateTier(
                                  tier.tempId,
                                  'minPerOrder',
                                  Math.max(1, parseInt(e.target.value, 10) || 1)
                                )
                              }
                              className="w-full px-3 py-2 rounded-xl bg-[#0E1015] border border-white/10 text-white text-xs font-mono focus:outline-none focus:border-[#D2FF00]"
                            />
                          </div>

                          <div>
                            <label className="block text-[11px] font-mono uppercase text-gray-400 mb-1">
                              Max Per Order
                            </label>
                            <input
                              type="number"
                              min="1"
                              value={tier.maxPerOrder}
                              onChange={(e) =>
                                updateTier(
                                  tier.tempId,
                                  'maxPerOrder',
                                  Math.max(1, parseInt(e.target.value, 10) || 1)
                                )
                              }
                              className="w-full px-3 py-2 rounded-xl bg-[#0E1015] border border-white/10 text-white text-xs font-mono focus:outline-none focus:border-[#D2FF00]"
                            />
                          </div>
                        </div>

                        {/* Description / Perks */}
                        <div>
                          <label className="block text-[11px] font-mono uppercase text-gray-400 mb-1">
                            Perks & Description
                          </label>
                          <input
                            type="text"
                            placeholder="e.g. Express fast-track queue, welcome cocktail, balcony sound access"
                            value={tier.description}
                            onChange={(e) =>
                              updateTier(tier.tempId, 'description', e.target.value)
                            }
                            className="w-full px-3 py-2 rounded-xl bg-[#0E1015] border border-white/10 text-white text-xs focus:outline-none focus:border-[#D2FF00]"
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* 6. Policies & Guidelines */}
            {activeSection === 'policies' && (
              <div className="bg-[#0E1015] rounded-2xl border border-white/10 p-6 sm:p-8 space-y-6 shadow-2xl">
                <div>
                  <h2 className="text-lg sm:text-xl font-display font-bold text-white">
                    Event Policies & Attendee Guidelines
                  </h2>
                  <p className="text-xs text-gray-400 mt-0.5">
                    Clear admission rules displayed to attendees on the event page.
                  </p>
                </div>

                <div className="space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-mono uppercase text-gray-300 font-semibold mb-1.5">
                        Age Restriction
                      </label>
                      <select
                        value={ageRestriction}
                        onChange={(e) => {
                          setAgeRestriction(e.target.value);
                          setHasUnsavedChanges(true);
                        }}
                        className="w-full px-4 py-2.5 rounded-xl bg-[#14171F] border border-white/10 text-white text-sm focus:outline-none focus:border-[#D2FF00] cursor-pointer"
                      >
                        <option value="All Ages">All Ages</option>
                        <option value="18+">18+ (Valid Photo ID Required)</option>
                        <option value="21+">21+ (Strict ID Enforcement)</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-xs font-mono uppercase text-gray-300 font-semibold mb-1.5">
                        Dress Code Guideline
                      </label>
                      <input
                        type="text"
                        placeholder="e.g. Minimalist Black / Savannah Chic"
                        value={dressCode}
                        onChange={(e) => {
                          setDressCode(e.target.value);
                          setHasUnsavedChanges(true);
                        }}
                        className="w-full px-4 py-2.5 rounded-xl bg-[#14171F] border border-white/10 text-white placeholder-gray-500 text-sm focus:outline-none focus:border-[#D2FF00]"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-mono uppercase text-gray-300 font-semibold mb-1.5">
                      Door Policy & Entry Rules
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. Valid government ID required, strict 10 PM gate lock, no outside drinks"
                      value={doorPolicy}
                      onChange={(e) => {
                        setDoorPolicy(e.target.value);
                        setHasUnsavedChanges(true);
                      }}
                      className="w-full px-4 py-2.5 rounded-xl bg-[#14171F] border border-white/10 text-white placeholder-gray-500 text-sm focus:outline-none focus:border-[#D2FF00]"
                    />
                  </div>
                </div>
              </div>
            )}

            {/* 7. Live Card Preview */}
            {activeSection === 'preview' && (
              <div className="bg-[#0E1015] rounded-2xl border border-white/10 p-6 sm:p-8 space-y-6 shadow-2xl">
                <div>
                  <h2 className="text-lg sm:text-xl font-display font-bold text-white">
                    Live Discovery Card Preview
                  </h2>
                  <p className="text-xs text-gray-400 mt-0.5">
                    This is how your event will appear on the Outside.vip public catalogue.
                  </p>
                </div>

                <div className="max-w-sm mx-auto">
                  <div className="rounded-xl overflow-hidden border border-gray-200 bg-white text-gray-900 shadow-md space-y-0">
                    <div className="aspect-[16/10] relative overflow-hidden bg-gray-100">
                      <img
                        src={coverImageUrl}
                        alt="Cover"
                        className="w-full h-full object-cover"
                      />
                      <div className="absolute top-2.5 right-2.5 px-2 py-0.5 rounded bg-black/80 text-white font-mono text-[10px] font-bold uppercase">
                        {category}
                      </div>
                    </div>

                    <div className="p-4 space-y-1.5">
                      <div className="text-[11px] font-mono uppercase tracking-wider text-gray-500 font-medium">
                        {new Date(startAt).toLocaleDateString('en-US', {
                          weekday: 'short',
                          month: 'short',
                          day: 'numeric',
                        })}
                      </div>
                      <h3 className="font-bold text-gray-900 text-base leading-snug line-clamp-1">
                        {title || 'Your Event Title'}
                      </h3>
                      <div className="text-xs text-gray-500 flex items-center justify-between pt-1">
                        <span className="truncate max-w-[150px]">
                          {venueName || city || 'Kenya'}
                        </span>
                        <span className="font-bold text-gray-900 font-mono">
                          From ${Math.min(...ticketTiers.map((t) => Number(t.price) || 0))}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </main>
        </div>
      </div>
    </div>
  );
};
