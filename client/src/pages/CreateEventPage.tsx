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
  const [coverImagePublicId, setCoverImagePublicId] = useState<string | null>(null);
  const [isUploadingImage, setIsUploadingImage] = useState(false);
  const [imageUploadError, setImageUploadError] = useState<string | null>(null);

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
      setCoverImagePublicId(evt.coverImagePublicId || null);
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

  // Image Upload handler (Cloudinary Direct & Server Upload Flow)
  const handleImageFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Reset input value so the user can re-select the same file if needed
    e.target.value = '';

    const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowedMimeTypes.includes(file.type)) {
      const msg = 'Please upload a valid image file (JPEG, PNG, or WebP).';
      setImageUploadError(msg);
      showNotification('error', msg);
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      const msg = 'Image size exceeds maximum allowed size of 5MB.';
      setImageUploadError(msg);
      showNotification('error', msg);
      return;
    }

    try {
      setIsUploadingImage(true);
      setImageUploadError(null);
      showNotification('success', 'Uploading image to Cloudinary...');

      const result = await api.organizer.uploadCoverImage(file);

      setCoverImageUrl(result.secure_url);
      setCoverImagePublicId(result.public_id);
      setHasUnsavedChanges(true);
      showNotification('success', 'Artwork uploaded to Cloudinary successfully.');
    } catch (err: any) {
      const msg = err.message || 'Failed to upload image to Cloudinary.';
      setImageUploadError(msg);
      showNotification('error', msg);
    } finally {
      setIsUploadingImage(false);
    }
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
      coverImagePublicId: coverImagePublicId || null,
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
      if (isUploadingImage) {
        throw new Error('Please wait for the image upload to complete before saving.');
      }

      if (!coverImageUrl || !coverImageUrl.trim()) {
        throw new Error('A cover artwork image is required for the event.');
      }

      // Disallow new Base64 uploads while allowing existing legacy Base64 for existing events
      if (coverImageUrl.startsWith('data:image/') && coverImageUrl !== existingData?.event?.coverImageUrl) {
        throw new Error('Base64 image data cannot be newly uploaded. Please use the image upload option.');
      }

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
      <div className="min-h-screen bg-[#FAF8F5] text-stone-900 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white border border-stone-200 rounded-xl p-8 space-y-4 text-center shadow-xs">
          <Lock className="w-10 h-10 text-stone-700 mx-auto" />
          <h2 className="font-display font-black text-xl text-stone-900 uppercase tracking-tight">Organizer Access Required</h2>
          <p className="text-xs text-stone-500 font-sans">
            Sign in as an event organizer to create, configure, and publish experiences.
          </p>
          <button
            onClick={() => quickLoginAs('organizer')}
            className="w-full py-2.5 rounded-lg bg-stone-900 hover:bg-black text-white font-semibold text-xs font-mono uppercase tracking-wider transition-colors shadow-2xs"
          >
            Sign in as Sol Collective (Demo)
          </button>
        </div>
      </div>
    );
  }

  if (isEditing && isLoadingExisting) {
    return (
      <div className="min-h-screen bg-[#FAF8F5] text-stone-900 flex items-center justify-center p-4">
        <div className="flex items-center gap-3 text-xs font-mono text-stone-600">
          <RefreshCw className="w-5 h-5 animate-spin text-stone-900" />
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
    <div className="min-h-screen bg-[#FAF8F5] text-stone-900 selection:bg-stone-900 selection:text-white pb-36">
      {/* Sticky Editor Command Bar */}
      <div className="sticky top-0 z-40 bg-[#FAF8F5]/90 backdrop-blur-md border-b border-stone-200/90 shadow-2xs">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 sm:gap-4 min-w-0">
            <Link
              to="/organizer"
              className="p-2 rounded-lg bg-white hover:bg-stone-100 text-stone-600 hover:text-stone-900 border border-stone-300 transition-colors shrink-0 shadow-2xs"
              title="Return to Organizer Dashboard"
            >
              <ArrowLeft className="w-4 h-4" />
            </Link>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-display font-black text-sm sm:text-base text-stone-900 truncate max-w-[180px] sm:max-w-md">
                  {title || 'Untitled Experience'}
                </span>
                {currentStatus === 'PUBLISHED' ? (
                  <span className="px-2 py-0.5 rounded text-[10px] font-mono uppercase bg-emerald-50 text-emerald-700 border border-emerald-300 font-bold shrink-0">
                    Live
                  </span>
                ) : (
                  <span className="px-2 py-0.5 rounded text-[10px] font-mono uppercase bg-amber-50 text-amber-700 border border-amber-300 font-bold shrink-0">
                    Draft
                  </span>
                )}
                {hasUnsavedChanges && (
                  <span className="text-[10px] font-mono text-stone-500 italic hidden md:inline">
                    • Unsaved changes
                  </span>
                )}
              </div>
              <span className="text-[11px] text-stone-500 font-mono hidden sm:block truncate">
                outside.vip/events/{generatedSlugPreview}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
            {/* Preview Button */}
            {id && (
              <Link
                to={`/organizer/events/${id}/preview`}
                className="hidden sm:inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white hover:bg-stone-100 text-stone-700 hover:text-stone-900 border border-stone-300 text-xs font-mono font-semibold transition-colors shadow-2xs"
                title="Preview Event in Public Layout"
              >
                <Eye className="w-3.5 h-3.5 text-stone-500" />
                <span>Preview</span>
              </Link>
            )}

            {/* Save Draft */}
            <button
              type="button"
              onClick={() => saveMutation.mutate({ publish: false })}
              disabled={saveMutation.isPending || isUploadingImage}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-white hover:bg-stone-100 text-stone-900 border border-stone-300 text-xs font-mono font-semibold transition-colors disabled:opacity-50 shadow-2xs"
            >
              <Save className="w-3.5 h-3.5 text-stone-500" />
              <span>{saveMutation.isPending ? 'Saving...' : 'Save Draft'}</span>
            </button>

            {/* Publish or Unpublish */}
            {currentStatus === 'PUBLISHED' ? (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => unpublishMutation.mutate()}
                  disabled={unpublishMutation.isPending || isUploadingImage}
                  className="px-3 py-2 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-300 text-xs font-mono font-semibold transition-colors disabled:opacity-50 shadow-2xs"
                >
                  Unpublish
                </button>
                <button
                  type="button"
                  onClick={() => saveMutation.mutate({ publish: false })}
                  disabled={saveMutation.isPending || isUploadingImage}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-stone-900 hover:bg-black text-white font-semibold text-xs font-mono uppercase tracking-wider transition-all duration-200 shadow-2xs disabled:opacity-50"
                >
                  Update Live
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => saveMutation.mutate({ publish: true })}
                disabled={saveMutation.isPending || isUploadingImage}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-stone-900 hover:bg-black text-white font-semibold text-xs font-mono uppercase tracking-wider transition-all duration-200 shadow-2xs disabled:opacity-50"
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
            className={`p-4 rounded-xl border text-xs font-medium flex items-center justify-between gap-3 shadow-2xs ${
              notification.type === 'success'
                ? 'bg-emerald-50 border-emerald-300 text-emerald-800'
                : 'bg-rose-50 border-rose-300 text-rose-800'
            }`}
          >
            <div className="flex items-center gap-2">
              {notification.type === 'success' ? (
                <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
              ) : (
                <AlertCircle className="w-5 h-5 text-rose-600 shrink-0" />
              )}
              <span>{notification.message}</span>
            </div>
            <button onClick={() => setNotification(null)} className="text-stone-500 hover:text-stone-900">
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
            <div className="text-[11px] font-mono uppercase tracking-wider text-stone-500 font-bold px-3 py-1">
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
                  className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-lg text-xs font-mono transition-colors text-left ${
                    isActive
                      ? 'bg-stone-900 text-white font-bold shadow-xs'
                      : 'text-stone-600 hover:text-stone-900 hover:bg-stone-200/60'
                  }`}
                >
                  <Icon className={`w-4 h-4 ${isActive ? 'text-white' : 'text-stone-400'}`} />
                  <span>{section.label}</span>
                </button>
              );
            })}

            {/* Quick summary box */}
            <div className="pt-4 mt-4 border-t border-stone-200/80 px-3 space-y-2 text-[11px] font-mono text-stone-500">
              <div className="flex justify-between">
                <span>Configured Tiers:</span>
                <span className="text-stone-900 font-bold">{ticketTiers.length}</span>
              </div>
              <div className="flex justify-between">
                <span>Total Capacity:</span>
                <span className="text-stone-900 font-bold">
                  {ticketTiers.reduce((acc, t) => acc + (Number(t.totalCapacity) || 0), 0)}
                </span>
              </div>
              <div className="flex justify-between">
                <span>Min Price:</span>
                <span className="text-stone-900 font-bold">
                  ${Math.min(...ticketTiers.map((t) => Number(t.price) || 0))}
                </span>
              </div>
            </div>
          </aside>

          {/* Form Content Area */}
          <main className="lg:col-span-9 space-y-6">
            {/* 1. Basic Information */}
            {activeSection === 'details' && (
              <div className="bg-white rounded-xl border border-stone-200/90 p-6 sm:p-8 space-y-6 shadow-xs">
                <div>
                  <h2 className="text-lg sm:text-xl font-display font-black text-stone-900 uppercase tracking-tight">
                    Basic Information & Narrative
                  </h2>
                  <p className="text-xs text-stone-500 mt-0.5 font-sans">
                    Establish your event's headline, editorial story, and category for discovery filters.
                  </p>
                </div>

                <div className="space-y-4">
                  <div>
                    <label className="block text-xs font-mono uppercase text-stone-700 font-bold mb-1.5">
                      Event Title <span className="text-stone-900">*</span>
                    </label>
                    <input
                      type="text"
                      placeholder="e.g. SOL FEST: Under The Baobab Tree"
                      value={title}
                      onChange={(e) => {
                        setTitle(e.target.value);
                        setHasUnsavedChanges(true);
                      }}
                      className="w-full px-3.5 py-2.5 rounded-lg bg-[#FAF8F5] border border-stone-300 text-stone-900 placeholder-stone-400 text-sm focus:outline-none focus:border-stone-900 focus:bg-white transition-colors"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-mono uppercase text-stone-700 font-bold mb-1.5">
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
                      className="w-full px-3.5 py-2.5 rounded-lg bg-[#FAF8F5] border border-stone-300 text-stone-900 placeholder-stone-400 text-sm focus:outline-none focus:border-stone-900 focus:bg-white transition-colors"
                    />
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-mono uppercase text-stone-700 font-bold mb-1.5">
                        Category
                      </label>
                      <select
                        value={category}
                        onChange={(e) => {
                          setCategory(e.target.value as EventCategory);
                          setHasUnsavedChanges(true);
                        }}
                        className="w-full px-3.5 py-2.5 rounded-lg bg-[#FAF8F5] border border-stone-300 text-stone-900 text-sm focus:outline-none focus:border-stone-900 focus:bg-white transition-colors cursor-pointer"
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
                      <label className="block text-xs font-mono uppercase text-stone-700 font-bold mb-1.5">
                        Generated Slug Preview
                      </label>
                      <div className="w-full px-3.5 py-2.5 rounded-lg bg-[#FAF8F5] border border-stone-200 text-stone-500 font-mono text-xs flex items-center justify-between">
                        <span className="truncate">/{generatedSlugPreview}</span>
                        <span className="text-[10px] uppercase text-stone-700 bg-stone-200/70 px-1.5 py-0.5 rounded font-bold">
                          Auto-Managed
                        </span>
                      </div>
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-mono uppercase text-stone-700 font-bold mb-1.5">
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
                      className="w-full px-3.5 py-2.5 rounded-lg bg-[#FAF8F5] border border-stone-300 text-stone-900 placeholder-stone-400 text-sm focus:outline-none focus:border-stone-900 focus:bg-white transition-colors leading-relaxed font-sans"
                    />
                  </div>
                </div>
              </div>
            )}

            {/* 2. Date & Schedule */}
            {activeSection === 'schedule' && (
              <div className="bg-white rounded-xl border border-stone-200/90 p-6 sm:p-8 space-y-6 shadow-xs">
                <div>
                  <h2 className="text-lg sm:text-xl font-display font-black text-stone-900 uppercase tracking-tight">
                    Date & Schedule
                  </h2>
                  <p className="text-xs text-stone-500 mt-0.5 font-sans">
                    Define start and conclusion times. Nairobi (EAT) is default.
                  </p>
                </div>

                <div className="space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-mono uppercase text-stone-700 font-bold mb-1.5">
                        Starts At <span className="text-stone-900">*</span>
                      </label>
                      <input
                        type="datetime-local"
                        value={startAt}
                        onChange={(e) => {
                          setStartAt(e.target.value);
                          setHasUnsavedChanges(true);
                        }}
                        className="w-full px-3.5 py-2.5 rounded-lg bg-[#FAF8F5] border border-stone-300 text-stone-900 text-sm focus:outline-none focus:border-stone-900 focus:bg-white transition-colors font-mono"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-mono uppercase text-stone-700 font-bold mb-1.5">
                        Ends At <span className="text-stone-900">*</span>
                      </label>
                      <input
                        type="datetime-local"
                        value={endAt}
                        onChange={(e) => {
                          setEndAt(e.target.value);
                          setHasUnsavedChanges(true);
                        }}
                        className="w-full px-3.5 py-2.5 rounded-lg bg-[#FAF8F5] border border-stone-300 text-stone-900 text-sm focus:outline-none focus:border-stone-900 focus:bg-white transition-colors font-mono"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-mono uppercase text-stone-700 font-bold mb-1.5">
                      Event Timezone
                    </label>
                    <select
                      value={timezone}
                      onChange={(e) => {
                        setTimezone(e.target.value);
                        setHasUnsavedChanges(true);
                      }}
                      className="w-full px-3.5 py-2.5 rounded-lg bg-[#FAF8F5] border border-stone-300 text-stone-900 text-sm focus:outline-none focus:border-stone-900 focus:bg-white transition-colors cursor-pointer"
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
              <div className="bg-white rounded-xl border border-stone-200/90 p-6 sm:p-8 space-y-6 shadow-xs">
                <div>
                  <h2 className="text-lg sm:text-xl font-display font-black text-stone-900 uppercase tracking-tight">
                    Venue & Location
                  </h2>
                  <p className="text-xs text-stone-500 mt-0.5 font-sans">
                    Physical venue and directions for event attendees.
                  </p>
                </div>

                <div className="space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-mono uppercase text-stone-700 font-bold mb-1.5">
                        Venue / Location Name <span className="text-stone-900">*</span>
                      </label>
                      <input
                        type="text"
                        placeholder="e.g. The Baobab Amphitheatre"
                        value={venueName}
                        onChange={(e) => {
                          setVenueName(e.target.value);
                          setHasUnsavedChanges(true);
                        }}
                        className="w-full px-3.5 py-2.5 rounded-lg bg-[#FAF8F5] border border-stone-300 text-stone-900 placeholder-stone-400 text-sm focus:outline-none focus:border-stone-900 focus:bg-white transition-colors"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-mono uppercase text-stone-700 font-bold mb-1.5">
                        City / Destination <span className="text-stone-900">*</span>
                      </label>
                      <input
                        type="text"
                        placeholder="Nairobi, Kilifi, Mombasa..."
                        value={city}
                        onChange={(e) => {
                          setCity(e.target.value);
                          setHasUnsavedChanges(true);
                        }}
                        className="w-full px-3.5 py-2.5 rounded-lg bg-[#FAF8F5] border border-stone-300 text-stone-900 placeholder-stone-400 text-sm focus:outline-none focus:border-stone-900 focus:bg-white transition-colors"
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
                            className={`px-2.5 py-1 rounded text-[10px] font-mono transition-colors ${
                              city === c
                                ? 'bg-stone-900 text-white font-bold'
                                : 'bg-stone-100 hover:bg-stone-200 text-stone-600'
                            }`}
                          >
                            {c}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-mono uppercase text-stone-700 font-bold mb-1.5">
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
                      className="w-full px-3.5 py-2.5 rounded-lg bg-[#FAF8F5] border border-stone-300 text-stone-900 placeholder-stone-400 text-sm focus:outline-none focus:border-stone-900 focus:bg-white transition-colors"
                    />
                  </div>
                </div>
              </div>
            )}

            {/* 4. Artwork & Flyer */}
            {activeSection === 'artwork' && (
              <div className="bg-white rounded-xl border border-stone-200/90 p-6 sm:p-8 space-y-6 shadow-xs">
                <div>
                  <h2 className="text-lg sm:text-xl font-display font-black text-stone-900 uppercase tracking-tight">
                    Artwork & Visual Identity
                  </h2>
                  <p className="text-xs text-stone-500 mt-0.5 font-sans">
                    High resolution cover artwork or event poster (16:10 aspect ratio recommended).
                  </p>
                </div>

                <div className="space-y-5">
                  {/* Upload or URL input */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-mono uppercase text-stone-700 font-bold mb-1.5">
                        Direct Cover URL
                      </label>
                      <input
                        type="url"
                        placeholder="https://..."
                        value={coverImageUrl}
                        onChange={(e) => {
                          setCoverImageUrl(e.target.value);
                          setCoverImagePublicId(null);
                          setImageUploadError(null);
                          setHasUnsavedChanges(true);
                        }}
                        className="w-full px-3.5 py-2.5 rounded-lg bg-[#FAF8F5] border border-stone-300 text-stone-900 placeholder-stone-400 text-xs focus:outline-none focus:border-stone-900 focus:bg-white transition-colors font-mono"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-mono uppercase text-stone-700 font-bold mb-1.5">
                        Upload Flyer File (Max 5MB)
                      </label>
                      <label
                        className={`w-full px-3.5 py-2.5 rounded-lg bg-[#FAF8F5] border border-dashed text-xs font-mono flex items-center justify-center gap-2 transition-colors ${
                          isUploadingImage
                            ? 'border-stone-400 text-stone-400 cursor-not-allowed'
                            : 'border-stone-300 hover:border-stone-900 text-stone-700 hover:text-stone-900 cursor-pointer'
                        }`}
                      >
                        {isUploadingImage ? (
                          <>
                            <RefreshCw className="w-4 h-4 text-stone-600 animate-spin" />
                            <span>Uploading to Cloudinary...</span>
                          </>
                        ) : (
                          <>
                            <Upload className="w-4 h-4 text-stone-600" />
                            <span>Choose Local Image File (JPEG, PNG, WebP)</span>
                          </>
                        )}
                        <input
                          type="file"
                          accept="image/jpeg,image/png,image/webp"
                          disabled={isUploadingImage}
                          onChange={handleImageFileChange}
                          className="hidden"
                        />
                      </label>
                      {imageUploadError && (
                        <p className="mt-1.5 text-[11px] font-mono text-red-600 flex items-center gap-1">
                          <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                          <span>{imageUploadError}</span>
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Preset Quick Select */}
                  <div>
                    <span className="text-[11px] font-mono text-stone-500 block mb-2">
                      Or select from curated Outside.vip event aesthetics:
                    </span>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                      {PRESET_COVERS.map((preset) => (
                        <button
                          key={preset.name}
                          type="button"
                          onClick={() => {
                            setCoverImageUrl(preset.url);
                            setCoverImagePublicId(null);
                            setImageUploadError(null);
                            setHasUnsavedChanges(true);
                          }}
                          className={`p-2 rounded-lg border text-left space-y-1.5 transition-all ${
                            coverImageUrl === preset.url
                              ? 'bg-stone-50 border-stone-900 ring-2 ring-stone-900'
                              : 'bg-white border-stone-200 hover:border-stone-400'
                          }`}
                        >
                          <div className="aspect-[16/10] rounded overflow-hidden bg-stone-900">
                            <img
                              src={preset.url}
                              alt={preset.name}
                              className="w-full h-full object-cover"
                            />
                          </div>
                          <span className="text-[11px] font-mono text-stone-700 font-bold block truncate">
                            {preset.name}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Artwork Live Preview */}
                  {coverImageUrl && (
                    <div className="space-y-2">
                      <span className="text-xs font-mono text-stone-500">Current Artwork Preview:</span>
                      <div className="relative aspect-[16/10] rounded-xl overflow-hidden bg-stone-900 border border-stone-200 max-w-xl">
                        <img
                          src={coverImageUrl}
                          alt="Cover Preview"
                          className="w-full h-full object-cover"
                        />
                        <div className="absolute bottom-3 right-3 px-3 py-1 rounded bg-black/80 backdrop-blur-md text-[11px] font-mono text-white border border-white/20 flex items-center gap-1.5">
                          {coverImagePublicId && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400"></span>}
                          {coverImagePublicId ? 'Cloudinary Hosted Flyer' : 'Active Flyer Preview'}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* 5. Ticket Tiers & Capacity */}
            {activeSection === 'tickets' && (
              <div className="bg-white rounded-xl border border-stone-200/90 p-6 sm:p-8 space-y-6 shadow-xs">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div>
                    <h2 className="text-lg sm:text-xl font-display font-black text-stone-900 uppercase tracking-tight">
                      Ticket Tiers & Inventory Management
                    </h2>
                    <p className="text-xs text-stone-500 mt-0.5 font-sans">
                      Configure prices, capacity, per-order limits, and sales windows. Free tickets ($0) supported.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={addTicketTier}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-stone-900 hover:bg-black text-white font-semibold text-xs font-mono uppercase tracking-wider transition-all duration-200 shadow-2xs shrink-0"
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
                        className="p-5 rounded-xl bg-[#FAF8F5] border border-stone-200 space-y-4"
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span className="w-5 h-5 rounded-full bg-stone-900 text-white flex items-center justify-center text-[10px] font-mono font-bold">
                              {index + 1}
                            </span>
                            <span className="text-xs font-mono text-stone-900 font-bold uppercase tracking-wider">
                              {tier.name || `Tier #${index + 1}`}
                            </span>
                            {hasSales && (
                              <span className="px-2 py-0.5 rounded bg-emerald-50 border border-emerald-300 text-emerald-700 text-[10px] font-mono font-bold">
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
                              className="px-2.5 py-1 rounded bg-white border border-stone-300 text-[11px] font-mono text-stone-700 focus:outline-none"
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
                                className={`p-1.5 rounded-lg text-stone-400 hover:text-rose-600 hover:bg-rose-50 transition-colors ${
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
                            <label className="block text-[11px] font-mono uppercase text-stone-600 font-semibold mb-1">
                              Tier Name <span className="text-stone-900">*</span>
                            </label>
                            <input
                              type="text"
                              value={tier.name}
                              onChange={(e) => updateTier(tier.tempId, 'name', e.target.value)}
                              placeholder="e.g. VIP Backstage Pass"
                              className="w-full px-3 py-2 rounded-lg bg-white border border-stone-300 text-stone-900 text-xs focus:outline-none focus:border-stone-900"
                            />
                          </div>

                          <div>
                            <label className="block text-[11px] font-mono uppercase text-stone-600 font-semibold mb-1">
                              Price (USD) <span className="text-stone-900">*</span>
                            </label>
                            <div className="relative">
                              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-stone-400 font-mono text-xs">
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
                                className="w-full pl-7 pr-3 py-2 rounded-lg bg-white border border-stone-300 text-stone-900 text-xs font-mono focus:outline-none focus:border-stone-900"
                              />
                            </div>
                          </div>
                        </div>

                        {/* Fields Row 2: Capacity, Min, Max */}
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                          <div>
                            <label className="block text-[11px] font-mono uppercase text-stone-600 font-semibold mb-1">
                              Total Capacity <span className="text-stone-900">*</span>
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
                              className="w-full px-3 py-2 rounded-lg bg-white border border-stone-300 text-stone-900 text-xs font-mono focus:outline-none focus:border-stone-900"
                            />
                          </div>

                          <div>
                            <label className="block text-[11px] font-mono uppercase text-stone-600 font-semibold mb-1">
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
                              className="w-full px-3 py-2 rounded-lg bg-white border border-stone-300 text-stone-900 text-xs font-mono focus:outline-none focus:border-stone-900"
                            />
                          </div>

                          <div>
                            <label className="block text-[11px] font-mono uppercase text-stone-600 font-semibold mb-1">
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
                              className="w-full px-3 py-2 rounded-lg bg-white border border-stone-300 text-stone-900 text-xs font-mono focus:outline-none focus:border-stone-900"
                            />
                          </div>
                        </div>

                        {/* Description / Perks */}
                        <div>
                          <label className="block text-[11px] font-mono uppercase text-stone-600 font-semibold mb-1">
                            Perks & Description
                          </label>
                          <input
                            type="text"
                            placeholder="e.g. Express fast-track queue, welcome cocktail, balcony sound access"
                            value={tier.description}
                            onChange={(e) =>
                              updateTier(tier.tempId, 'description', e.target.value)
                            }
                            className="w-full px-3 py-2 rounded-lg bg-white border border-stone-300 text-stone-900 text-xs focus:outline-none focus:border-stone-900"
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
              <div className="bg-white rounded-xl border border-stone-200/90 p-6 sm:p-8 space-y-6 shadow-xs">
                <div>
                  <h2 className="text-lg sm:text-xl font-display font-black text-stone-900 uppercase tracking-tight">
                    Event Policies & Attendee Guidelines
                  </h2>
                  <p className="text-xs text-stone-500 mt-0.5 font-sans">
                    Clear admission rules displayed to attendees on the event page.
                  </p>
                </div>

                <div className="space-y-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-mono uppercase text-stone-700 font-bold mb-1.5">
                        Age Restriction
                      </label>
                      <select
                        value={ageRestriction}
                        onChange={(e) => {
                          setAgeRestriction(e.target.value);
                          setHasUnsavedChanges(true);
                        }}
                        className="w-full px-3.5 py-2.5 rounded-lg bg-[#FAF8F5] border border-stone-300 text-stone-900 text-sm focus:outline-none focus:border-stone-900 cursor-pointer"
                      >
                        <option value="All Ages">All Ages</option>
                        <option value="18+">18+ (Valid Photo ID Required)</option>
                        <option value="21+">21+ (Strict ID Enforcement)</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-xs font-mono uppercase text-stone-700 font-bold mb-1.5">
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
                        className="w-full px-3.5 py-2.5 rounded-lg bg-[#FAF8F5] border border-stone-300 text-stone-900 placeholder-stone-400 text-sm focus:outline-none focus:border-stone-900"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-mono uppercase text-stone-700 font-bold mb-1.5">
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
                      className="w-full px-3.5 py-2.5 rounded-lg bg-[#FAF8F5] border border-stone-300 text-stone-900 placeholder-stone-400 text-sm focus:outline-none focus:border-stone-900"
                    />
                  </div>
                </div>
              </div>
            )}

            {/* 7. Live Card Preview */}
            {activeSection === 'preview' && (
              <div className="bg-white rounded-xl border border-stone-200/90 p-6 sm:p-8 space-y-6 shadow-xs">
                <div>
                  <h2 className="text-lg sm:text-xl font-display font-black text-stone-900 uppercase tracking-tight">
                    Live Discovery Card Preview
                  </h2>
                  <p className="text-xs text-stone-500 mt-0.5 font-sans">
                    This is how your event will appear in the Outside.vip public discovery catalogue.
                  </p>
                </div>

                <div className="max-w-sm mx-auto">
                  <div className="rounded-lg overflow-hidden border border-stone-200 bg-white text-stone-900 shadow-md p-3 space-y-3">
                    <div className="aspect-[16/10] relative overflow-hidden rounded-md bg-stone-900">
                      <img
                        src={coverImageUrl}
                        alt="Cover"
                        className="w-full h-full object-cover"
                      />
                      <div className="absolute top-2.5 right-2.5 px-2 py-0.5 rounded bg-black/80 text-white font-mono text-[10px] font-bold uppercase">
                        {category}
                      </div>
                    </div>

                    <div className="space-y-1.5">
                      <div className="text-[11px] font-mono uppercase tracking-wider text-stone-500 font-bold">
                        {new Date(startAt).toLocaleDateString('en-US', {
                          weekday: 'short',
                          month: 'short',
                          day: 'numeric',
                        }).toUpperCase()}
                      </div>
                      <h3 className="font-display font-black text-stone-900 text-base uppercase leading-snug line-clamp-1">
                        {title || 'Your Event Title'}
                      </h3>
                      <div className="text-xs text-stone-500 flex items-center justify-between pt-1">
                        <span className="truncate max-w-[150px] font-mono text-[11px]">
                          {venueName || city || 'Kenya'}
                        </span>
                        <span className="font-bold text-stone-900 font-mono text-xs">
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
