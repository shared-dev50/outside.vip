import React, { useState, useEffect, useMemo } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import {
  EventCategory,
  TicketTierStatus,
  RecurrenceFrequency,
  EventFeatureType,
  EventGalleryImage,
  EventFeature,
} from '../types';
import {
  ArrowLeft,
  Save,
  Globe,
  Calendar,
  Ticket,
  Eye,
  EyeOff,
  Plus,
  Trash2,
  Sparkles,
  CheckCircle2,
  AlertCircle,
  Upload,
  RefreshCw,
  X,
  Lock,
  Repeat,
  ChevronRight,
  ChevronLeft,
  Check,
  Ban,
  Clock,
  Layers,
  Image as ImageIcon,
  Video,
  Users,
  Shield,
  ArrowUp,
  ArrowDown,
} from 'lucide-react';
import { calculateTierEarnings, calculateCombinedEarnings, formatCents } from '../lib/fees';
import { extractYouTubeVideoId, getYouTubeEmbedUrl } from '../lib/youtube';

export type WizardStep = 1 | 2 | 3 | 4;

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
  waitlistEnabled?: boolean;
  waitlistWaitingCount?: number;
  waitlistOfferedCount?: number;
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

const WEEKDAY_NAMES = [
  { label: 'Sun', value: 0 },
  { label: 'Mon', value: 1 },
  { label: 'Tue', value: 2 },
  { label: 'Wed', value: 3 },
  { label: 'Thu', value: 4 },
  { label: 'Fri', value: 5 },
  { label: 'Sat', value: 6 },
];

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

  // Wizard Step (1: Details & Artwork, 2: Date & Location, 3: Tickets & Policies, 4: Discovery Preview)
  const [currentStep, setCurrentStep] = useState<WizardStep>(1);

  // Step 1: Details & Artwork Form State
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<EventCategory>('MUSIC');
  const [coverImageUrl, setCoverImageUrl] = useState(PRESET_COVERS[0].url);
  const [coverImagePublicId, setCoverImagePublicId] = useState<string | null>(null);
  const [isUploadingImage, setIsUploadingImage] = useState(false);
  const [imageUploadError, setImageUploadError] = useState<string | null>(null);

  // Event Gallery State (Step 1)
  const [galleryImages, setGalleryImages] = useState<EventGalleryImage[]>([]);
  const [isUploadingGallery, setIsUploadingGallery] = useState(false);
  const [galleryUploadError, setGalleryUploadError] = useState<string | null>(null);
  const [galleryUrlInput, setGalleryUrlInput] = useState('');

  // Page Settings & Media (Step 4)
  const [youtubeVideoUrl, setYoutubeVideoUrl] = useState('');
  const [showOnExplore, setShowOnExplore] = useState(true);
  const [hideGuestCount, setHideGuestCount] = useState(false);
  const [isPasswordProtected, setIsPasswordProtected] = useState(false);
  const [password, setPassword] = useState('');
  const [showPasswordText, setShowPasswordText] = useState(false);

  // Event Features State (Step 4)
  const [features, setFeatures] = useState<EventFeature[]>([]);
  const [isAddingFeature, setIsAddingFeature] = useState(false);
  const [newFeatureName, setNewFeatureName] = useState('');
  const [newFeatureType, setNewFeatureType] = useState<EventFeatureType>('PERFORMER');
  const [newFeatureImage, setNewFeatureImage] = useState('');
  const [newFeatureDesc, setNewFeatureDesc] = useState('');
  const [isUploadingFeatureImage, setIsUploadingFeatureImage] = useState(false);
  const [featureUploadError, setFeatureUploadError] = useState<string | null>(null);


  // Step 2: Date & Location Form State
  const [startAt, setStartAt] = useState('2026-11-20T20:00');
  const [endAt, setEndAt] = useState('2026-11-21T04:00');
  const [timezone, setTimezone] = useState('Africa/Nairobi');

  // Recurrence Configuration State
  const [isRecurring, setIsRecurring] = useState(false);
  const [recurrenceFrequency, setRecurrenceFrequency] = useState<RecurrenceFrequency>('WEEKLY');
  const [recurrenceInterval, setRecurrenceInterval] = useState(1);
  const [recurrenceWeekdays, setRecurrenceWeekdays] = useState<number[]>([5]); // Default Friday (5)
  const [recurrenceEndType, setRecurrenceEndType] = useState<'count' | 'until'>('count');
  const [recurrenceCount, setRecurrenceCount] = useState(4);
  const [recurrenceEndDate, setRecurrenceEndDate] = useState('2026-12-31T23:59');
  const [applyToFuture, setApplyToFuture] = useState(false);

  // Venue State
  const [venueName, setVenueName] = useState('');
  const [venueAddress, setVenueAddress] = useState('');
  const [city, setCity] = useState('Nairobi');
  const [country, setCountry] = useState('Kenya');

  // Step 3: Policies Form State
  const [ageRestriction, setAgeRestriction] = useState('18+');
  const [dressCode, setDressCode] = useState('');
  const [doorPolicy, setDoorPolicy] = useState('');

  // Status & Edit Tracking
  const [currentStatus, setCurrentStatus] = useState<'DRAFT' | 'PUBLISHED' | 'CANCELLED'>('DRAFT');
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);

  // Cancellation Modal State
  const [showCancelModal, setShowCancelModal] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelSeriesMode, setCancelSeriesMode] = useState(false);

  // Step 3: Ticket Tiers Form State
  const [ticketTiers, setTicketTiers] = useState<FormTicketTier[]>([
    {
      tempId: 'default-1',
      name: 'Early Bird General Admission',
      description: 'Standard entrance with early arrival benefits before 10 PM.',
      price: 25,
      totalCapacity: 250,
      minPerOrder: 1,
      maxPerOrder: 6,
      salesStartAt: '',
      salesEndAt: '',
      status: 'ACTIVE',
      waitlistEnabled: false,
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
      waitlistEnabled: false,
    },
  ]);

  const [notification, setNotification] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  const showNotification = (type: 'success' | 'error', message: string) => {
    setNotification({ type, message });
    setTimeout(() => setNotification(null), 6000);
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
      setCurrentStatus(evt.status as 'DRAFT' | 'PUBLISHED' | 'CANCELLED');

      if (evt.seriesId) {
        setIsRecurring(true);
      }

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
            waitlistEnabled: Boolean(tier.waitlistEnabled),
            waitlistWaitingCount: tier.waitlistWaitingCount || 0,
            waitlistOfferedCount: tier.waitlistOfferedCount || 0,
          }))
        );
      }
      if (evt.galleryImages && Array.isArray(evt.galleryImages)) {
        setGalleryImages(evt.galleryImages);
      }
      if (evt.features && Array.isArray(evt.features)) {
        setFeatures(evt.features);
      }
      setYoutubeVideoUrl(evt.youtubeVideoUrl || '');
      setShowOnExplore(evt.showOnExplore !== undefined ? evt.showOnExplore : true);
      setHideGuestCount(evt.hideGuestCount !== undefined ? evt.hideGuestCount : false);
      setIsPasswordProtected(evt.isPasswordProtected !== undefined ? evt.isPasswordProtected : false);
      setPassword('');

      setHasUnsavedChanges(false);
    }
  }, [existingData]);

  // Synchronize default recurrence weekday from startAt
  useEffect(() => {
    if (!isEditing && startAt) {
      const d = new Date(startAt);
      if (!isNaN(d.getTime())) {
        const day = d.getDay();
        setRecurrenceWeekdays((prev) => (prev.length === 0 ? [day] : prev));
      }
    }
  }, [startAt, isEditing]);

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
        waitlistEnabled: false,
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
      if (e.target) {
        e.target.value = '';
      }
    }
  };

  // Gallery file upload & management
  const handleGalleryFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (galleryImages.length >= 10) {
      const msg = 'Maximum limit of 10 gallery images reached.';
      setGalleryUploadError(msg);
      showNotification('error', msg);
      return;
    }

    const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowedMimeTypes.includes(file.type)) {
      const msg = 'Please upload a valid image file (JPEG, PNG, or WebP).';
      setGalleryUploadError(msg);
      showNotification('error', msg);
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      const msg = 'Gallery image exceeds 5MB limit.';
      setGalleryUploadError(msg);
      showNotification('error', msg);
      return;
    }

    try {
      setIsUploadingGallery(true);
      setGalleryUploadError(null);
      const result = await api.organizer.uploadImage(file);
      setGalleryImages((prev) => [
        ...prev,
        {
          imageUrl: result.secure_url,
          publicId: result.public_id,
          displayOrder: prev.length,
        },
      ]);
      setHasUnsavedChanges(true);
      showNotification('success', 'Gallery image uploaded successfully.');
    } catch (err: any) {
      const msg = err.message || 'Failed to upload gallery image.';
      setGalleryUploadError(msg);
      showNotification('error', msg);
    } finally {
      setIsUploadingGallery(false);
      if (e.target) e.target.value = '';
    }
  };

  const handleAddGalleryUrl = () => {
    const url = galleryUrlInput.trim();
    if (!url) return;
    if (galleryImages.length >= 10) {
      showNotification('error', 'Maximum limit of 10 gallery images reached.');
      return;
    }
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      showNotification('error', 'Please enter a valid HTTP or HTTPS image URL.');
      return;
    }
    setGalleryImages((prev) => [
      ...prev,
      {
        imageUrl: url,
        publicId: null,
        displayOrder: prev.length,
      },
    ]);
    setGalleryUrlInput('');
    setHasUnsavedChanges(true);
  };

  const removeGalleryImage = (index: number) => {
    setGalleryImages((prev) => prev.filter((_, i) => i !== index));
    setHasUnsavedChanges(true);
  };

  const moveGalleryImage = (index: number, direction: 'up' | 'down') => {
    setGalleryImages((prev) => {
      const targetIndex = direction === 'up' ? index - 1 : index + 1;
      if (targetIndex < 0 || targetIndex >= prev.length) return prev;
      const copy = [...prev];
      const temp = copy[index];
      copy[index] = copy[targetIndex];
      copy[targetIndex] = temp;
      return copy.map((img, i) => ({ ...img, displayOrder: i }));
    });
    setHasUnsavedChanges(true);
  };

  // Feature actions
  const handleFeatureImageFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowedMimeTypes.includes(file.type)) {
      setFeatureUploadError('Please upload a valid image file (JPEG, PNG, or WebP).');
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      setFeatureUploadError('Image exceeds 5MB limit.');
      return;
    }

    try {
      setIsUploadingFeatureImage(true);
      setFeatureUploadError(null);
      const res = await api.organizer.uploadImage(file);
      setNewFeatureImage(res.secure_url);
    } catch (err: any) {
      setFeatureUploadError(err.message || 'Failed to upload feature image.');
    } finally {
      setIsUploadingFeatureImage(false);
      if (e.target) e.target.value = '';
    }
  };

  const addFeature = () => {
    if (!newFeatureName.trim()) {
      showNotification('error', 'Feature name is required (e.g. performer, speaker, or sponsor name).');
      return;
    }
    if (features.length >= 50) {
      showNotification('error', 'Maximum limit of 50 features reached.');
      return;
    }
    setFeatures((prev) => [
      ...prev,
      {
        name: newFeatureName.trim(),
        type: newFeatureType,
        imageUrl: newFeatureImage.trim() || null,
        description: newFeatureDesc.trim() || null,
        displayOrder: prev.length,
      },
    ]);
    setNewFeatureName('');
    setNewFeatureType('PERFORMER');
    setNewFeatureImage('');
    setNewFeatureDesc('');
    setIsAddingFeature(false);
    setHasUnsavedChanges(true);
  };

  const removeFeature = (index: number) => {
    setFeatures((prev) => prev.filter((_, i) => i !== index));
    setHasUnsavedChanges(true);
  };

  const moveFeature = (index: number, direction: 'up' | 'down') => {
    setFeatures((prev) => {
      const targetIndex = direction === 'up' ? index - 1 : index + 1;
      if (targetIndex < 0 || targetIndex >= prev.length) return prev;
      const copy = [...prev];
      const temp = copy[index];
      copy[index] = copy[targetIndex];
      copy[targetIndex] = temp;
      return copy.map((feat, i) => ({ ...feat, displayOrder: i }));
    });
    setHasUnsavedChanges(true);
  };


  // Toggle Weekday chip selection
  const toggleWeekday = (day: number) => {
    setRecurrenceWeekdays((prev) => {
      if (prev.includes(day)) {
        if (prev.length <= 1) {
          showNotification('error', 'At least one weekday must be selected for weekly recurrence.');
          return prev;
        }
        return prev.filter((d) => d !== day);
      } else {
        return [...prev, day].sort();
      }
    });
    setHasUnsavedChanges(true);
  };

  // Client-side occurrence schedule preview
  const occurrenceSchedulePreview = useMemo(() => {
    if (!isRecurring) return [];
    const startDate = new Date(startAt);
    const endDate = new Date(endAt);
    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) return [];
    const durationMs = Math.max(0, endDate.getTime() - startDate.getTime());

    const occurrences: Array<{ index: number; startAt: Date; endAt: Date }> = [];
    const maxCount = recurrenceEndType === 'count' ? Math.min(52, Math.max(1, recurrenceCount || 1)) : 52;
    const untilDate = recurrenceEndType === 'until' && recurrenceEndDate ? new Date(recurrenceEndDate) : null;

    let current = new Date(startDate.getTime());
    let count = 0;

    if (recurrenceFrequency === 'DAILY') {
      while (count < maxCount) {
        if (untilDate && current.getTime() > untilDate.getTime()) break;
        occurrences.push({
          index: count + 1,
          startAt: new Date(current.getTime()),
          endAt: new Date(current.getTime() + durationMs),
        });
        count++;
        current.setDate(current.getDate() + Math.max(1, recurrenceInterval));
      }
    } else if (recurrenceFrequency === 'WEEKLY') {
      const targetWeekdays = recurrenceWeekdays.length > 0 ? recurrenceWeekdays : [startDate.getDay()];
      const cursor = new Date(startDate.getTime());
      let safetyCounter = 0;
      while (count < maxCount && safetyCounter < 400) {
        safetyCounter++;
        if (untilDate && cursor.getTime() > untilDate.getTime()) break;
        if (targetWeekdays.includes(cursor.getDay()) && cursor.getTime() >= startDate.getTime()) {
          occurrences.push({
            index: count + 1,
            startAt: new Date(cursor.getTime()),
            endAt: new Date(cursor.getTime() + durationMs),
          });
          count++;
        }
        cursor.setDate(cursor.getDate() + 1);
      }
    } else if (recurrenceFrequency === 'MONTHLY') {
      while (count < maxCount) {
        if (untilDate && current.getTime() > untilDate.getTime()) break;
        occurrences.push({
          index: count + 1,
          startAt: new Date(current.getTime()),
          endAt: new Date(current.getTime() + durationMs),
        });
        count++;
        current.setMonth(current.getMonth() + Math.max(1, recurrenceInterval));
      }
    }

    return occurrences;
  }, [
    isRecurring,
    startAt,
    endAt,
    recurrenceFrequency,
    recurrenceInterval,
    recurrenceWeekdays,
    recurrenceEndType,
    recurrenceCount,
    recurrenceEndDate,
  ]);

  const detectedVideoId = useMemo(() => extractYouTubeVideoId(youtubeVideoUrl), [youtubeVideoUrl]);

  // Step-level validation
  const validateStep = (stepNumber: WizardStep): boolean => {
    if (stepNumber === 1) {
      if (!title.trim() || title.trim().length < 2) {
        showNotification('error', 'Event title is required (at least 2 characters).');
        return false;
      }
      if (!coverImageUrl || !coverImageUrl.trim()) {
        showNotification('error', 'A cover artwork image or flyer is required.');
        return false;
      }
    } else if (stepNumber === 2) {
      const startMs = new Date(startAt).getTime();
      const endMs = new Date(endAt).getTime();
      if (isNaN(startMs) || isNaN(endMs)) {
        showNotification('error', 'Please provide valid start and end dates.');
        return false;
      }
      if (endMs <= startMs) {
        showNotification('error', 'Event end time must be after the start time.');
        return false;
      }
      if (!venueName.trim()) {
        showNotification('error', 'Venue or location name is required.');
        return false;
      }
      if (!city.trim()) {
        showNotification('error', 'City or destination is required.');
        return false;
      }
      if (isRecurring && !isEditing) {
        if (recurrenceInterval < 1) {
          showNotification('error', 'Recurrence interval must be at least 1.');
          return false;
        }
        if (recurrenceFrequency === 'WEEKLY' && recurrenceWeekdays.length === 0) {
          showNotification('error', 'Please select at least one weekday for weekly recurrence.');
          return false;
        }
        if (recurrenceEndType === 'count' && (recurrenceCount < 1 || recurrenceCount > 52)) {
          showNotification('error', 'Recurrence count must be between 1 and 52 occurrences.');
          return false;
        }
        if (recurrenceEndType === 'until') {
          const untilMs = new Date(recurrenceEndDate).getTime();
          if (isNaN(untilMs) || untilMs <= startMs) {
            showNotification('error', 'Recurrence end date must be after the start date.');
            return false;
          }
        }
      }
    } else if (stepNumber === 3) {
      if (ticketTiers.length === 0) {
        showNotification('error', 'At least one ticket tier is required.');
        return false;
      }
      for (const tier of ticketTiers) {
        if (!tier.name.trim()) {
          showNotification('error', 'All ticket tiers must have a valid tier name.');
          return false;
        }
        if (tier.totalCapacity < 1) {
          showNotification('error', `Capacity for "${tier.name}" must be at least 1.`);
          return false;
        }
      }
    }
    return true;
  };

  const handleNextStep = () => {
    if (validateStep(currentStep)) {
      if (currentStep < 4) {
        setCurrentStep((prev) => (prev + 1) as WizardStep);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    }
  };

  const handlePrevStep = () => {
    if (currentStep > 1) {
      setCurrentStep((prev) => (prev - 1) as WizardStep);
      window.scrollTo({ top: 0, behavior: 'smooth' });
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
      waitlistEnabled: Boolean(tier.waitlistEnabled),
    }));

    const fullDescription = doorPolicy.trim() && !description.includes(doorPolicy.trim())
      ? (description.trim() ? `${description.trim()}\n\nDoor Policy: ${doorPolicy.trim()}` : `Door Policy: ${doorPolicy.trim()}`)
      : description.trim();

    const recurrencePayload = isRecurring && !isEditing ? {
      frequency: recurrenceFrequency,
      interval: Math.max(1, Number(recurrenceInterval) || 1),
      byWeekday: recurrenceFrequency === 'WEEKLY' ? (recurrenceWeekdays.length ? recurrenceWeekdays : [new Date(startAt).getDay()]) : undefined,
      until: recurrenceEndType === 'until' ? toIsoValue(recurrenceEndDate) : undefined,
      count: recurrenceEndType === 'count' ? Math.max(1, Number(recurrenceCount) || 1) : undefined,
      timezone: timezone || 'Africa/Nairobi',
    } : undefined;

    return {
      title: title.trim() || 'Untitled Experience Draft',
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
      recurrence: recurrencePayload,
      applyToFuture: (isEditing && existingData?.event?.seriesId) ? applyToFuture : undefined,
      galleryImages: galleryImages.map((img, i) => ({
        imageUrl: img.imageUrl,
        publicId: img.publicId || null,
        displayOrder: i,
      })),
      features: features.map((feat, i) => ({
        name: feat.name.trim(),
        type: feat.type,
        imageUrl: feat.imageUrl || null,
        imagePublicId: feat.imagePublicId || null,
        description: feat.description?.trim() || null,
        displayOrder: i,
      })),
      youtubeVideoUrl: youtubeVideoUrl.trim() || null,
      showOnExplore,
      hideGuestCount,
      isPasswordProtected,
      ...(password.trim() ? { password: password.trim() } : {}),
    };
  };

  // Save / Publish Mutation
  const saveMutation = useMutation({
    mutationFn: async ({ publish }: { publish: boolean }) => {
      if (isUploadingImage) {
        throw new Error('Please wait for the image upload to complete before saving.');
      }

      if (!coverImageUrl || !coverImageUrl.trim()) {
        throw new Error('A cover artwork image is required for the event.');
      }

      if (coverImageUrl.startsWith('data:image/') && coverImageUrl !== existingData?.event?.coverImageUrl) {
        throw new Error('Base64 image data cannot be newly uploaded. Please use the image upload option.');
      }

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
          await api.organizer.publishEvent(savedEventId, applyToFuture);
        }
      } else {
        const res = await api.organizer.createEvent(payload);
        savedEventId = res.event.id;
        if (publish && res.event.status !== 'PUBLISHED') {
          await api.organizer.publishEvent(savedEventId, isRecurring);
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
          ? isRecurring && !isEditing
            ? 'Recurring event series published live to Outside.vip discovery!'
            : 'Event published live to Outside.vip discovery!'
          : isRecurring && !isEditing
          ? 'Recurring event series saved as draft in PostgreSQL.'
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

  // Unpublish Mutation
  const unpublishMutation = useMutation({
    mutationFn: async ({ unpublishSeries }: { unpublishSeries?: boolean }) => {
      if (!id) return;
      return api.organizer.unpublishEvent(id, unpublishSeries);
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

  // Cancel Occurrence or Series Mutation
  const cancelMutation = useMutation({
    mutationFn: async () => {
      if (!id) return;
      if (cancelSeriesMode && existingData?.event?.seriesId) {
        return api.organizer.cancelSeries(existingData.event.seriesId, cancelReason);
      } else {
        return api.organizer.cancelEvent(id, cancelReason);
      }
    },
    onSuccess: () => {
      setShowCancelModal(false);
      setCurrentStatus('CANCELLED');
      queryClient.invalidateQueries({ queryKey: ['organizer-dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['organizer-events'] });
      queryClient.invalidateQueries({ queryKey: ['organizer-event', id] });
      queryClient.invalidateQueries({ queryKey: ['events'] });
      showNotification(
        'success',
        cancelSeriesMode
          ? 'Recurring event series has been cancelled.'
          : 'This event occurrence has been cancelled.'
      );
    },
    onError: (err: any) => {
      showNotification('error', err?.message || 'Failed to cancel event.');
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

  const combinedEarnings = calculateCombinedEarnings(
    ticketTiers.map((t) => ({
      priceInCents: Math.round((Number(t.price) || 0) * 100),
      capacity: Math.max(0, Number(t.totalCapacity) || 0),
    }))
  );

  const wizardSteps = [
    {
      number: 1 as WizardStep,
      title: 'Details & Artwork',
      shortLabel: '1. Details',
      subtitle: 'Title, category, story & flyer cover',
      icon: Sparkles,
    },
    {
      number: 2 as WizardStep,
      title: 'Date & Location',
      shortLabel: '2. Schedule',
      subtitle: 'Schedule, recurrence & venue',
      icon: Calendar,
    },
    {
      number: 3 as WizardStep,
      title: 'Tickets & Policies',
      shortLabel: '3. Tickets',
      subtitle: 'Tiers, capacity, pricing & rules',
      icon: Ticket,
    },
    {
      number: 4 as WizardStep,
      title: 'Discovery Preview',
      shortLabel: '4. Preview',
      subtitle: 'Discovery card, schedule & publish',
      icon: Eye,
    },
  ];

  return (
    <div className="min-h-screen bg-[#FAF8F5] text-stone-900 selection:bg-stone-900 selection:text-white pb-36">
      {/* Sticky Top Command Bar */}
      <div className="sticky top-0 z-40 bg-[#FAF8F5]/95 backdrop-blur-md border-b border-stone-200 shadow-2xs">
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
                  {title || 'Untitled Experience Draft'}
                </span>
                {currentStatus === 'PUBLISHED' ? (
                  <span className="px-2 py-0.5 rounded text-[10px] font-mono uppercase bg-emerald-50 text-emerald-700 border border-emerald-300 font-bold shrink-0">
                    Live
                  </span>
                ) : currentStatus === 'CANCELLED' ? (
                  <span className="px-2 py-0.5 rounded text-[10px] font-mono uppercase bg-rose-50 text-rose-700 border border-rose-300 font-bold shrink-0">
                    Cancelled
                  </span>
                ) : (
                  <span className="px-2 py-0.5 rounded text-[10px] font-mono uppercase bg-amber-50 text-amber-700 border border-amber-300 font-bold shrink-0">
                    Draft
                  </span>
                )}
                {existingData?.event?.seriesId && (
                  <span className="px-2 py-0.5 rounded text-[10px] font-mono uppercase bg-blue-50 text-blue-700 border border-blue-300 font-bold shrink-0 flex items-center gap-1">
                    <Repeat className="w-3 h-3" />
                    Series
                  </span>
                )}
                {hasUnsavedChanges && (
                  <span className="text-[10px] font-mono text-stone-500 italic hidden md:inline">
                    • Unsaved changes
                  </span>
                )}
              </div>
              <div className="text-[11px] text-stone-500 font-mono hidden sm:flex items-center gap-2">
                <span>Four-Step Wizard</span>
                <span>•</span>
                <span>Step {currentStep} of 4: {wizardSteps[currentStep - 1].title}</span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 sm:gap-3 shrink-0">
            {id && (
              <Link
                to={`/organizer/events/${id}/preview`}
                className="hidden sm:inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-white hover:bg-stone-100 text-stone-700 hover:text-stone-900 border border-stone-300 text-xs font-mono font-semibold transition-colors shadow-2xs"
                title="Preview Event in Public Layout"
              >
                <Eye className="w-3.5 h-3.5 text-stone-500" />
                <span>Public View</span>
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

            {/* Publish or Status Controls */}
            {currentStatus === 'PUBLISHED' ? (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => unpublishMutation.mutate({})}
                  disabled={unpublishMutation.isPending || isUploadingImage}
                  className="px-3 py-2 rounded-lg bg-stone-100 hover:bg-stone-200 text-stone-700 border border-stone-300 text-xs font-mono font-semibold transition-colors disabled:opacity-50 shadow-2xs"
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
                <span>
                  {saveMutation.isPending
                    ? 'Publishing...'
                    : isRecurring && !isEditing
                    ? 'Publish Series'
                    : 'Publish Live'}
                </span>
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

      {/* Wizard Progress Stepper Header */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 mt-6">
        <div className="bg-white border border-stone-200 rounded-xl p-4 sm:p-5 shadow-xs">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4">
            {wizardSteps.map((step) => {
              const StepIcon = step.icon;
              const isActive = currentStep === step.number;
              const isPassed = currentStep > step.number;
              return (
                <button
                  key={step.number}
                  type="button"
                  onClick={() => {
                    if (isPassed || validateStep(currentStep)) {
                      setCurrentStep(step.number);
                    }
                  }}
                  className={`flex items-center gap-3 p-3 rounded-lg text-left transition-all ${
                    isActive
                      ? 'bg-stone-900 text-white shadow-xs'
                      : isPassed
                      ? 'bg-stone-100/80 hover:bg-stone-200/70 text-stone-900'
                      : 'bg-transparent text-stone-400 hover:text-stone-600'
                  }`}
                >
                  <div
                    className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 text-xs font-mono font-bold transition-colors ${
                      isActive
                        ? 'bg-white text-stone-900'
                        : isPassed
                        ? 'bg-emerald-600 text-white'
                        : 'border border-stone-300 text-stone-500'
                    }`}
                  >
                    {isPassed ? <Check className="w-4 h-4 stroke-[3]" /> : step.number}
                  </div>
                  <div className="min-w-0">
                    <div className="text-xs font-mono font-bold uppercase tracking-wider truncate flex items-center gap-1.5">
                      <StepIcon className="w-3.5 h-3.5 shrink-0 hidden sm:inline" />
                      <span>{step.title}</span>
                    </div>
                    <div
                      className={`text-[10px] font-sans truncate hidden sm:block ${
                        isActive ? 'text-stone-300' : 'text-stone-500'
                      }`}
                    >
                      {step.subtitle}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Main Wizard Form Body */}
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 mt-6">
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          {/* Sidebar / Quick Summary Card */}
          <aside className="lg:col-span-3 space-y-4 lg:sticky lg:top-24 order-2 lg:order-1">
            <div className="bg-white rounded-xl border border-stone-200 p-5 space-y-4 shadow-xs">
              <div className="text-[11px] font-mono uppercase tracking-wider text-stone-500 font-bold border-b border-stone-100 pb-2">
                Wizard Navigation
              </div>

              <div className="space-y-1.5">
                {wizardSteps.map((step) => {
                  const Icon = step.icon;
                  const isActive = currentStep === step.number;
                  return (
                    <button
                      key={step.number}
                      type="button"
                      onClick={() => {
                        if (currentStep > step.number || validateStep(currentStep)) {
                          setCurrentStep(step.number);
                        }
                      }}
                      className={`w-full flex items-center justify-between px-3 py-2 rounded-lg text-xs font-mono text-left transition-colors ${
                        isActive
                          ? 'bg-stone-900 text-white font-bold'
                          : 'text-stone-600 hover:text-stone-900 hover:bg-stone-100'
                      }`}
                    >
                      <div className="flex items-center gap-2.5">
                        <Icon className={`w-3.5 h-3.5 ${isActive ? 'text-white' : 'text-stone-400'}`} />
                        <span>{step.number}. {step.title}</span>
                      </div>
                      {currentStep > step.number && (
                        <Check className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                      )}
                    </button>
                  );
                })}
              </div>

              {/* Event Metrics Summary */}
              <div className="pt-3 border-t border-stone-200/80 space-y-2 text-[11px] font-mono text-stone-500">
                <div className="flex justify-between">
                  <span>Schedule Type:</span>
                  <span className="text-stone-900 font-bold">
                    {isRecurring ? `Recurring (${occurrenceSchedulePreview.length} dates)` : 'Single Event'}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>Ticket Tiers:</span>
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
                <div className="flex justify-between">
                  <span>Est. Gross (Sold Out):</span>
                  <span className="text-emerald-600 font-bold">
                    {formatCents(combinedEarnings.totalProjectedEarningsInCents)}
                  </span>
                </div>
              </div>

              {/* Separate Finance & Org Link notice */}
              <div className="pt-3 border-t border-stone-200/80">
                <Link
                  to="/organizer/finance"
                  className="flex items-center justify-between text-[11px] font-mono text-stone-600 hover:text-stone-900 p-2 rounded-lg bg-stone-50 hover:bg-stone-100 transition-colors"
                >
                  <span className="font-semibold">Finance & Payout Settings</span>
                  <ChevronRight className="w-3.5 h-3.5 text-stone-400" />
                </Link>
              </div>

              {/* Cancel Occurrence or Series option if editing */}
              {isEditing && currentStatus !== 'CANCELLED' && (
                <div className="pt-2 border-t border-stone-200/80">
                  <button
                    type="button"
                    onClick={() => {
                      setCancelSeriesMode(false);
                      setCancelReason('');
                      setShowCancelModal(true);
                    }}
                    className="w-full py-1.5 text-center text-[11px] font-mono text-rose-600 hover:text-rose-800 hover:bg-rose-50 rounded transition-colors"
                  >
                    Cancel Event Occurrence
                  </button>
                  {existingData?.event?.seriesId && (
                    <button
                      type="button"
                      onClick={() => {
                        setCancelSeriesMode(true);
                        setCancelReason('');
                        setShowCancelModal(true);
                      }}
                      className="w-full mt-1 py-1.5 text-center text-[11px] font-mono text-rose-700 hover:text-rose-900 hover:bg-rose-50 rounded transition-colors font-bold"
                    >
                      Cancel Entire Series
                    </button>
                  )}
                </div>
              )}
            </div>
          </aside>

          {/* Form Step Content */}
          <main className="lg:col-span-9 space-y-6 order-1 lg:order-2">
            {/* STEP 1: EVENT DETAILS & ARTWORK */}
            {currentStep === 1 && (
              <div className="bg-white rounded-xl border border-stone-200/90 p-6 sm:p-8 space-y-6 shadow-xs">
                <div>
                  <div className="flex items-center gap-2 text-stone-500 text-xs font-mono uppercase tracking-wider font-semibold">
                    <span>Step 1 of 4</span>
                    <span>•</span>
                    <span>Basic Details & Visual Identity</span>
                  </div>
                  <h2 className="text-xl sm:text-2xl font-display font-black text-stone-900 uppercase tracking-tight mt-1">
                    Event Details & Artwork
                  </h2>
                  <p className="text-xs text-stone-500 mt-1 font-sans">
                    Establish your experience's headline, category for discovery filters, description narrative, and high-impact cover flyer.
                  </p>
                </div>

                <div className="space-y-5">
                  {/* Event Title */}
                  <div>
                    <label className="block text-xs font-mono uppercase text-stone-700 font-bold mb-1.5">
                      Event Title <span className="text-rose-600">*</span>
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

                  {/* Category Selection */}
                  <div>
                    <label className="block text-xs font-mono uppercase text-stone-700 font-bold mb-1.5">
                      Category & Experience Genre <span className="text-rose-600">*</span>
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

                  {/* Full Description & Narrative */}
                  <div>
                    <label className="block text-xs font-mono uppercase text-stone-700 font-bold mb-1.5">
                      Full Description & Experience Narrative
                    </label>
                    <textarea
                      rows={5}
                      placeholder="Lineup, stage schedule, immersive installations, curated mixology, audio architecture, parking details..."
                      value={description}
                      onChange={(e) => {
                        setDescription(e.target.value);
                        setHasUnsavedChanges(true);
                      }}
                      className="w-full px-3.5 py-2.5 rounded-lg bg-[#FAF8F5] border border-stone-300 text-stone-900 placeholder-stone-400 text-sm focus:outline-none focus:border-stone-900 focus:bg-white transition-colors leading-relaxed font-sans"
                    />
                  </div>

                  {/* Cover Artwork & Flyer (Integrated from old Step 4) */}
                  <div className="pt-4 border-t border-stone-200">
                    <div>
                      <h3 className="text-sm font-display font-black text-stone-900 uppercase tracking-tight">
                        Cover Artwork & Flyer Poster <span className="text-rose-600">*</span>
                      </h3>
                      <p className="text-xs text-stone-500 mt-0.5 font-sans">
                        Upload a high-resolution 16:10 flyer, supply an image URL, or select from curated Outside.vip presets.
                      </p>
                    </div>

                    <div className="mt-4 space-y-4">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                        <div>
                          <label className="block text-xs font-mono uppercase text-stone-700 font-bold mb-1.5">
                            Direct Image URL
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
                          <label
                            htmlFor="flyer-file-upload"
                            className="block text-xs font-mono uppercase text-stone-700 font-bold mb-1.5 cursor-pointer"
                          >
                            Upload Local Flyer (Max 5MB)
                          </label>
                          <label
                            htmlFor="flyer-file-upload"
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
                                <span>Choose Local File (JPEG, PNG, WebP)</span>
                              </>
                            )}
                            <input
                              id="flyer-file-upload"
                              type="file"
                              accept="image/jpeg,image/png,image/webp"
                              disabled={isUploadingImage}
                              onClick={(e) => {
                                (e.target as HTMLInputElement).value = '';
                              }}
                              onChange={handleImageFileChange}
                              className="sr-only"
                            />
                          </label>
                          {imageUploadError && (
                            <p className="mt-1.5 text-[11px] font-mono text-rose-600 flex items-center gap-1">
                              <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                              <span>{imageUploadError}</span>
                            </p>
                          )}
                        </div>
                      </div>

                      {/* Presets */}
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

                      {/* Artwork Preview */}
                      {coverImageUrl && (
                        <div className="space-y-1.5 pt-2">
                          <span className="text-xs font-mono text-stone-500">Active Artwork Preview:</span>
                          <div className="relative aspect-[16/10] rounded-xl overflow-hidden bg-stone-900 border border-stone-200 max-w-lg">
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

                  {/* Event Image Gallery (Optional) */}
                  <div className="pt-6 border-t border-stone-200 space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <h3 className="text-sm font-display font-black text-stone-900 uppercase tracking-tight flex items-center gap-2">
                          <ImageIcon className="w-4 h-4 text-stone-700" />
                          <span>Event Image Gallery (Optional)</span>
                        </h3>
                        <p className="text-xs text-stone-500 mt-0.5 font-sans">
                          Upload up to 10 photos showcasing the venue atmosphere, production, and crowd experience.
                        </p>
                      </div>
                      <span className="px-2.5 py-0.5 rounded text-[11px] font-mono font-bold bg-stone-100 text-stone-700 border border-stone-200">
                        {galleryImages.length} / 10 Images
                      </span>
                    </div>

                    {/* Upload & Add controls */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label
                          htmlFor="gallery-file-upload"
                          className="block text-xs font-mono uppercase text-stone-700 font-bold mb-1.5 cursor-pointer"
                        >
                          Upload Gallery Image (Cloudinary)
                        </label>
                        <label
                          htmlFor="gallery-file-upload"
                          className={`w-full px-3.5 py-2.5 rounded-lg bg-[#FAF8F5] border border-dashed text-xs font-mono flex items-center justify-center gap-2 transition-colors ${
                            isUploadingGallery || galleryImages.length >= 10
                              ? 'border-stone-300 text-stone-400 cursor-not-allowed'
                              : 'border-stone-300 hover:border-stone-900 text-stone-700 hover:text-stone-900 cursor-pointer'
                          }`}
                        >
                          {isUploadingGallery ? (
                            <>
                              <RefreshCw className="w-4 h-4 text-stone-600 animate-spin" />
                              <span>Uploading to Gallery...</span>
                            </>
                          ) : (
                            <>
                              <Upload className="w-4 h-4 text-stone-600" />
                              <span>Choose Photo (Max 5MB)</span>
                            </>
                          )}
                          <input
                            id="gallery-file-upload"
                            type="file"
                            accept="image/jpeg,image/png,image/webp"
                            disabled={isUploadingGallery || galleryImages.length >= 10}
                            onClick={(e) => {
                              (e.target as HTMLInputElement).value = '';
                            }}
                            onChange={handleGalleryFileChange}
                            className="sr-only"
                          />
                        </label>
                        {galleryUploadError && (
                          <p className="mt-1.5 text-[11px] font-mono text-rose-600 flex items-center gap-1">
                            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                            <span>{galleryUploadError}</span>
                          </p>
                        )}
                      </div>

                      <div>
                        <label className="block text-xs font-mono uppercase text-stone-700 font-bold mb-1.5">
                          Or Add via Image URL
                        </label>
                        <div className="flex gap-2">
                          <input
                            type="url"
                            placeholder="https://images.unsplash.com/..."
                            value={galleryUrlInput}
                            disabled={galleryImages.length >= 10}
                            onChange={(e) => setGalleryUrlInput(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault();
                                handleAddGalleryUrl();
                              }
                            }}
                            className="flex-1 px-3 py-2 rounded-lg bg-[#FAF8F5] border border-stone-300 text-stone-900 placeholder-stone-400 text-xs focus:outline-none focus:border-stone-900 focus:bg-white transition-colors font-mono disabled:opacity-50"
                          />
                          <button
                            type="button"
                            onClick={handleAddGalleryUrl}
                            disabled={!galleryUrlInput.trim() || galleryImages.length >= 10}
                            className="px-3 py-2 rounded-lg bg-stone-900 hover:bg-black text-white font-mono text-xs font-semibold disabled:opacity-40 transition-colors shrink-0"
                          >
                            Add
                          </button>
                        </div>
                      </div>
                    </div>

                    {/* Gallery Images Grid with Reordering */}
                    {galleryImages.length > 0 ? (
                      <div className="space-y-2 pt-2">
                        <span className="text-xs font-mono text-stone-500">
                          Reorder or Remove Gallery Images (first images appear prominently):
                        </span>
                        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">
                          {galleryImages.map((img, idx) => (
                            <div
                              key={img.imageUrl + idx}
                              className="group relative rounded-lg overflow-hidden border border-stone-200 bg-stone-900 aspect-[4/3] shadow-xs"
                            >
                              <img
                                src={img.imageUrl}
                                alt={`Gallery ${idx + 1}`}
                                className="w-full h-full object-cover transition-transform group-hover:scale-105 duration-300"
                              />

                              {/* Index Badge */}
                              <div className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded bg-black/75 backdrop-blur-xs text-[10px] font-mono text-white font-bold">
                                #{idx + 1}
                              </div>

                              {/* Action controls overlay */}
                              <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-1.5 p-1">
                                <button
                                  type="button"
                                  disabled={idx === 0}
                                  onClick={() => moveGalleryImage(idx, 'up')}
                                  title="Move earlier"
                                  className="w-7 h-7 rounded bg-white/90 hover:bg-white text-stone-900 flex items-center justify-center disabled:opacity-30 disabled:cursor-not-allowed shadow-xs transition-colors"
                                >
                                  <ArrowLeft className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  type="button"
                                  disabled={idx === galleryImages.length - 1}
                                  onClick={() => moveGalleryImage(idx, 'down')}
                                  title="Move later"
                                  className="w-7 h-7 rounded bg-white/90 hover:bg-white text-stone-900 flex items-center justify-center disabled:opacity-30 disabled:cursor-not-allowed shadow-xs transition-colors"
                                >
                                  <ChevronRight className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => removeGalleryImage(idx)}
                                  title="Remove image"
                                  className="w-7 h-7 rounded bg-rose-600 hover:bg-rose-700 text-white flex items-center justify-center shadow-xs transition-colors"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <div className="p-4 rounded-lg bg-[#FAF8F5] border border-stone-200 text-center text-xs font-mono text-stone-500">
                        No gallery photos added yet. Upload up to 10 photos to enrich your event page.
                      </div>
                    )}
                  </div>
                </div>

                {/* Step Navigation Actions */}
                <div className="pt-6 border-t border-stone-200 flex items-center justify-between">
                  <div className="text-xs font-mono text-stone-500">
                    Step 1 of 4 completed
                  </div>
                  <button
                    type="button"
                    onClick={handleNextStep}
                    className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-stone-900 hover:bg-black text-white font-mono text-xs font-semibold uppercase tracking-wider transition-colors shadow-2xs"
                  >
                    <span>Next: Date & Location</span>
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}

            {/* STEP 2: DATE & LOCATION (With Recurring Events Engine) */}
            {currentStep === 2 && (
              <div className="bg-white rounded-xl border border-stone-200/90 p-6 sm:p-8 space-y-6 shadow-xs">
                <div>
                  <div className="flex items-center gap-2 text-stone-500 text-xs font-mono uppercase tracking-wider font-semibold">
                    <span>Step 2 of 4</span>
                    <span>•</span>
                    <span>Timing, Recurrence & Physical Venue</span>
                  </div>
                  <h2 className="text-xl sm:text-2xl font-display font-black text-stone-900 uppercase tracking-tight mt-1">
                    Date & Location
                  </h2>
                  <p className="text-xs text-stone-500 mt-1 font-sans">
                    Configure event start/end schedule, recurrence rules for series, and physical location coordinates.
                  </p>
                </div>

                {/* Existing Series Info Banner if editing an event in a series */}
                {isEditing && existingData?.event?.seriesId && (
                  <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 space-y-2 text-xs">
                    <div className="flex items-center gap-2 text-blue-900 font-mono font-bold">
                      <Repeat className="w-4 h-4" />
                      <span>This event is part of a recurring series (Occurrence #{existingData.event.occurrenceIndex || 1})</span>
                    </div>
                    <p className="text-blue-700 font-sans">
                      You are editing this individual occurrence. You can choose whether changes apply to this occurrence only, or propagate to all future occurrences in this series.
                    </p>
                    <label className="flex items-center gap-2 pt-1 font-mono text-blue-950 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={applyToFuture}
                        onChange={(e) => setApplyToFuture(e.target.checked)}
                        className="rounded border-blue-400 text-blue-600 focus:ring-blue-500 h-4 w-4"
                      />
                      <span className="font-semibold">Apply date/venue updates to all future occurrences in this series</span>
                    </label>
                  </div>
                )}

                <div className="space-y-6">
                  {/* Schedule Timings */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label className="block text-xs font-mono uppercase text-stone-700 font-bold mb-1.5">
                        Starts At <span className="text-rose-600">*</span>
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
                        Ends At <span className="text-rose-600">*</span>
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

                  {/* RECURRING SERIES TOGGLE & CONFIGURATION */}
                  {!isEditing && (
                    <div className="pt-4 border-t border-stone-200 space-y-4">
                      <div className="flex items-center justify-between p-4 rounded-xl bg-stone-50 border border-stone-200">
                        <div className="space-y-0.5">
                          <div className="flex items-center gap-2">
                            <Repeat className="w-4 h-4 text-stone-800" />
                            <span className="font-display font-black text-sm uppercase text-stone-900">
                              Recurring Series Schedule
                            </span>
                          </div>
                          <p className="text-xs text-stone-500 font-sans">
                            Automatically generate individual occurrences on a daily, weekly, or monthly schedule with isolated ticket inventories.
                          </p>
                        </div>
                        <label className="relative inline-flex items-center cursor-pointer shrink-0">
                          <input
                            type="checkbox"
                            checked={isRecurring}
                            onChange={(e) => {
                              setIsRecurring(e.target.checked);
                              setHasUnsavedChanges(true);
                            }}
                            className="sr-only peer"
                          />
                          <div className="w-11 h-6 bg-stone-300 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-stone-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-stone-900"></div>
                        </label>
                      </div>

                      {/* Recurrence Configuration Panel */}
                      {isRecurring && (
                        <div className="p-5 rounded-xl border border-stone-200 bg-[#FAF8F5] space-y-5">
                          {/* Frequency Tabs */}
                          <div>
                            <label className="block text-xs font-mono uppercase text-stone-700 font-bold mb-2">
                              Recurrence Frequency
                            </label>
                            <div className="grid grid-cols-3 gap-2">
                              {(['DAILY', 'WEEKLY', 'MONTHLY'] as RecurrenceFrequency[]).map((freq) => (
                                <button
                                  key={freq}
                                  type="button"
                                  onClick={() => {
                                    setRecurrenceFrequency(freq);
                                    setHasUnsavedChanges(true);
                                  }}
                                  className={`py-2 px-3 rounded-lg text-xs font-mono font-bold transition-all text-center ${
                                    recurrenceFrequency === freq
                                      ? 'bg-stone-900 text-white shadow-2xs'
                                      : 'bg-white border border-stone-200 text-stone-600 hover:text-stone-900'
                                  }`}
                                >
                                  {freq}
                                </button>
                              ))}
                            </div>
                          </div>

                          {/* Recurrence Interval */}
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            <div>
                              <label className="block text-xs font-mono uppercase text-stone-700 font-bold mb-1.5">
                                Repeat Every
                              </label>
                              <div className="flex items-center gap-2">
                                <input
                                  type="number"
                                  min={1}
                                  max={30}
                                  value={recurrenceInterval}
                                  onChange={(e) => {
                                    setRecurrenceInterval(Math.max(1, parseInt(e.target.value) || 1));
                                    setHasUnsavedChanges(true);
                                  }}
                                  className="w-24 px-3 py-2 rounded-lg bg-white border border-stone-300 text-stone-900 text-sm font-mono focus:outline-none focus:border-stone-900"
                                />
                                <span className="text-xs font-mono text-stone-600">
                                  {recurrenceFrequency === 'DAILY'
                                    ? recurrenceInterval > 1 ? 'days' : 'day'
                                    : recurrenceFrequency === 'WEEKLY'
                                    ? recurrenceInterval > 1 ? 'weeks' : 'week'
                                    : recurrenceInterval > 1 ? 'months' : 'month'}
                                </span>
                              </div>
                            </div>

                            {/* End Condition Choice */}
                            <div>
                              <label className="block text-xs font-mono uppercase text-stone-700 font-bold mb-1.5">
                                Series End Condition
                              </label>
                              <div className="flex items-center gap-4 pt-1">
                                <label className="inline-flex items-center gap-1.5 text-xs font-mono cursor-pointer">
                                  <input
                                    type="radio"
                                    name="recurrenceEndType"
                                    checked={recurrenceEndType === 'count'}
                                    onChange={() => {
                                      setRecurrenceEndType('count');
                                      setHasUnsavedChanges(true);
                                    }}
                                    className="text-stone-900 focus:ring-stone-900"
                                  />
                                  <span>After Occurrence Count</span>
                                </label>
                                <label className="inline-flex items-center gap-1.5 text-xs font-mono cursor-pointer">
                                  <input
                                    type="radio"
                                    name="recurrenceEndType"
                                    checked={recurrenceEndType === 'until'}
                                    onChange={() => {
                                      setRecurrenceEndType('until');
                                      setHasUnsavedChanges(true);
                                    }}
                                    className="text-stone-900 focus:ring-stone-900"
                                  />
                                  <span>On Specific Date</span>
                                </label>
                              </div>
                            </div>
                          </div>

                          {/* Specific Weekdays Selector (only for WEEKLY) */}
                          {recurrenceFrequency === 'WEEKLY' && (
                            <div>
                              <label className="block text-xs font-mono uppercase text-stone-700 font-bold mb-1.5">
                                Applicable Weekdays
                              </label>
                              <div className="flex flex-wrap gap-2">
                                {WEEKDAY_NAMES.map((wd) => {
                                  const isSelected = recurrenceWeekdays.includes(wd.value);
                                  return (
                                    <button
                                      key={wd.value}
                                      type="button"
                                      onClick={() => toggleWeekday(wd.value)}
                                      className={`px-3 py-1.5 rounded-lg text-xs font-mono transition-colors font-semibold ${
                                        isSelected
                                          ? 'bg-stone-900 text-white'
                                          : 'bg-white border border-stone-200 text-stone-600 hover:border-stone-400'
                                      }`}
                                    >
                                      {wd.label}
                                    </button>
                                  );
                                })}
                              </div>
                            </div>
                          )}

                          {/* End Value Input */}
                          {recurrenceEndType === 'count' ? (
                            <div>
                              <label className="block text-xs font-mono uppercase text-stone-700 font-bold mb-1.5">
                                Number of Occurrences (Max 52)
                              </label>
                              <div className="flex items-center gap-2">
                                <input
                                  type="number"
                                  min={2}
                                  max={52}
                                  value={recurrenceCount}
                                  onChange={(e) => {
                                    setRecurrenceCount(Math.min(52, Math.max(1, parseInt(e.target.value) || 1)));
                                    setHasUnsavedChanges(true);
                                  }}
                                  className="w-24 px-3 py-2 rounded-lg bg-white border border-stone-300 text-stone-900 text-sm font-mono focus:outline-none focus:border-stone-900"
                                />
                                <span className="text-xs font-mono text-stone-600">scheduled events</span>
                              </div>
                            </div>
                          ) : (
                            <div>
                              <label className="block text-xs font-mono uppercase text-stone-700 font-bold mb-1.5">
                                Repeat Until Date
                              </label>
                              <input
                                type="datetime-local"
                                value={recurrenceEndDate}
                                onChange={(e) => {
                                  setRecurrenceEndDate(e.target.value);
                                  setHasUnsavedChanges(true);
                                }}
                                className="w-full sm:w-72 px-3 py-2 rounded-lg bg-white border border-stone-300 text-stone-900 text-sm font-mono focus:outline-none focus:border-stone-900"
                              />
                            </div>
                          )}

                          {/* Live Schedule Preview Box */}
                          <div className="pt-3 border-t border-stone-200">
                            <div className="flex items-center justify-between mb-2">
                              <span className="text-xs font-mono uppercase font-bold text-stone-700 flex items-center gap-1.5">
                                <Clock className="w-3.5 h-3.5 text-stone-500" />
                                <span>Generated Schedule Preview ({occurrenceSchedulePreview.length} Occurrences)</span>
                              </span>
                              <span className="text-[10px] font-mono text-stone-500">
                                Timezone: {timezone}
                              </span>
                            </div>

                            <div className="max-h-48 overflow-y-auto space-y-1.5 p-3 rounded-lg bg-white border border-stone-200 text-xs font-mono">
                              {occurrenceSchedulePreview.map((occ) => (
                                <div
                                  key={occ.index}
                                  className="flex items-center justify-between py-1 px-2 rounded hover:bg-stone-50 text-stone-700"
                                >
                                  <div className="flex items-center gap-2">
                                    <span className="w-6 text-stone-400 font-bold">#{occ.index}</span>
                                    <span>
                                      {occ.startAt.toLocaleDateString('en-US', {
                                        weekday: 'short',
                                        month: 'short',
                                        day: 'numeric',
                                        year: 'numeric',
                                      })}
                                    </span>
                                  </div>
                                  <span className="text-stone-500 text-[11px]">
                                    {occ.startAt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })} -{' '}
                                    {occ.endAt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
                                  </span>
                                </div>
                              ))}
                            </div>
                            <p className="text-[11px] font-sans text-stone-500 mt-2">
                              Each occurrence receives isolated ticket tiers, orders, capacity reservations, and attendee check-in QR scanner support.
                            </p>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Venue & Location Section */}
                  <div className="pt-4 border-t border-stone-200 space-y-4">
                    <div>
                      <h3 className="text-sm font-display font-black text-stone-900 uppercase tracking-tight">
                        Physical Venue & Destination
                      </h3>
                      <p className="text-xs text-stone-500 mt-0.5 font-sans">
                        Where will attendees arrive for this experience?
                      </p>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div>
                        <label className="block text-xs font-mono uppercase text-stone-700 font-bold mb-1.5">
                          Venue / Location Name <span className="text-rose-600">*</span>
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
                          City / Destination <span className="text-rose-600">*</span>
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

                {/* Step Navigation Actions */}
                <div className="pt-6 border-t border-stone-200 flex items-center justify-between">
                  <button
                    type="button"
                    onClick={handlePrevStep}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-stone-300 bg-white hover:bg-stone-100 text-stone-700 font-mono text-xs font-semibold transition-colors shadow-2xs"
                  >
                    <ChevronLeft className="w-4 h-4" />
                    <span>Back: Details & Artwork</span>
                  </button>

                  <button
                    type="button"
                    onClick={handleNextStep}
                    className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-stone-900 hover:bg-black text-white font-mono text-xs font-semibold uppercase tracking-wider transition-colors shadow-2xs"
                  >
                    <span>Next: Tickets & Policies</span>
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}

            {/* STEP 3: TICKETS & POLICIES */}
            {currentStep === 3 && (
              <div className="bg-white rounded-xl border border-stone-200/90 p-6 sm:p-8 space-y-6 shadow-xs">
                <div>
                  <div className="flex items-center gap-2 text-stone-500 text-xs font-mono uppercase tracking-wider font-semibold">
                    <span>Step 3 of 4</span>
                    <span>•</span>
                    <span>Pricing, Capacity & Door Policies</span>
                  </div>
                  <h2 className="text-xl sm:text-2xl font-display font-black text-stone-900 uppercase tracking-tight mt-1">
                    Tickets & Policies
                  </h2>
                  <p className="text-xs text-stone-500 mt-1 font-sans">
                    Configure ticket tiers, prices, inventory limits, and attendee admission policies.
                  </p>
                </div>

                {/* Ticket Tiers Management */}
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="text-sm font-display font-black text-stone-900 uppercase tracking-tight">
                        Ticket Tiers & Capacity
                      </h3>
                      <p className="text-xs text-stone-500 font-sans">
                        Each tier supports independent pricing, inventory reservation, and per-order restrictions. Free tickets ($0) supported.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={addTicketTier}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-stone-900 hover:bg-black text-white font-mono text-xs font-semibold uppercase tracking-wider transition-colors shadow-2xs shrink-0"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>Add Tier</span>
                    </button>
                  </div>

                  <div className="space-y-4">
                    {ticketTiers.map((tier, idx) => {
                      const tierEarnings = calculateTierEarnings(
                        Math.round((Number(tier.price) || 0) * 100),
                        Math.max(0, Number(tier.totalCapacity) || 0)
                      );

                      return (
                        <div
                          key={tier.tempId}
                          className="rounded-xl border border-stone-200 bg-[#FAF8F5] p-5 space-y-4"
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div className="flex items-center gap-2">
                              <span className="w-6 h-6 rounded-full bg-stone-200 text-stone-700 font-mono text-xs font-bold flex items-center justify-center">
                                {idx + 1}
                              </span>
                              <span className="font-display font-black text-base text-stone-900 uppercase">
                                {tier.name || 'Untitled Tier'}
                              </span>
                              {tier.soldQuantity && tier.soldQuantity > 0 ? (
                                <span className="px-2 py-0.5 rounded text-[10px] font-mono uppercase bg-emerald-50 text-emerald-700 border border-emerald-300 font-bold">
                                  {tier.soldQuantity} Sold
                                </span>
                              ) : null}
                            </div>
                            <button
                              type="button"
                              onClick={() => removeTicketTier(tier.tempId)}
                              className="p-1.5 rounded-md hover:bg-stone-200/80 text-stone-400 hover:text-rose-600 transition-colors"
                              title="Delete Tier"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </div>

                          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                            <div className="sm:col-span-2">
                              <label className="block text-[11px] font-mono uppercase text-stone-700 font-bold mb-1">
                                Tier Name <span className="text-rose-600">*</span>
                              </label>
                              <input
                                type="text"
                                value={tier.name}
                                onChange={(e) => updateTier(tier.tempId, 'name', e.target.value)}
                                className="w-full px-3 py-2 rounded-lg bg-white border border-stone-300 text-stone-900 text-xs focus:outline-none focus:border-stone-900"
                              />
                            </div>
                            <div>
                              <label className="block text-[11px] font-mono uppercase text-stone-700 font-bold mb-1">
                                Status
                              </label>
                              <select
                                value={tier.status}
                                onChange={(e) => updateTier(tier.tempId, 'status', e.target.value as TicketTierStatus)}
                                className="w-full px-3 py-2 rounded-lg bg-white border border-stone-300 text-stone-900 text-xs focus:outline-none focus:border-stone-900"
                              >
                                <option value="ACTIVE">ACTIVE (On Sale)</option>
                                <option value="PAUSED">PAUSED (Paused)</option>
                                <option value="HIDDEN">HIDDEN (Secret)</option>
                              </select>
                            </div>
                          </div>

                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                            <div>
                              <label className="block text-[11px] font-mono uppercase text-stone-700 font-bold mb-1">
                                Price ($ USD) <span className="text-rose-600">*</span>
                              </label>
                              <input
                                type="number"
                                min={0}
                                step={1}
                                value={tier.price}
                                onChange={(e) => updateTier(tier.tempId, 'price', Math.max(0, parseFloat(e.target.value) || 0))}
                                className="w-full px-3 py-2 rounded-lg bg-white border border-stone-300 text-stone-900 text-xs font-mono focus:outline-none focus:border-stone-900"
                              />
                            </div>
                            <div>
                              <label className="block text-[11px] font-mono uppercase text-stone-700 font-bold mb-1">
                                Capacity <span className="text-rose-600">*</span>
                              </label>
                              <input
                                type="number"
                                min={1}
                                value={tier.totalCapacity}
                                onChange={(e) => updateTier(tier.tempId, 'totalCapacity', Math.max(1, parseInt(e.target.value) || 1))}
                                className="w-full px-3 py-2 rounded-lg bg-white border border-stone-300 text-stone-900 text-xs font-mono focus:outline-none focus:border-stone-900"
                              />
                            </div>
                            <div>
                              <label className="block text-[11px] font-mono uppercase text-stone-700 font-bold mb-1">
                                Min / Order
                              </label>
                              <input
                                type="number"
                                min={1}
                                value={tier.minPerOrder}
                                onChange={(e) => updateTier(tier.tempId, 'minPerOrder', Math.max(1, parseInt(e.target.value) || 1))}
                                className="w-full px-3 py-2 rounded-lg bg-white border border-stone-300 text-stone-900 text-xs font-mono focus:outline-none focus:border-stone-900"
                              />
                            </div>
                            <div>
                              <label className="block text-[11px] font-mono uppercase text-stone-700 font-bold mb-1">
                                Max / Order
                              </label>
                              <input
                                type="number"
                                min={1}
                                value={tier.maxPerOrder}
                                onChange={(e) => updateTier(tier.tempId, 'maxPerOrder', Math.max(1, parseInt(e.target.value) || 1))}
                                className="w-full px-3 py-2 rounded-lg bg-white border border-stone-300 text-stone-900 text-xs font-mono focus:outline-none focus:border-stone-900"
                              />
                            </div>
                          </div>

                          {/* Enable Waitlist Setting */}
                          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3.5 rounded-lg bg-white border border-stone-200">
                            <div className="space-y-0.5 max-w-md">
                              <div className="flex items-center gap-2">
                                <label className="text-xs font-mono uppercase font-bold text-stone-900 cursor-pointer">
                                  Enable Waitlist
                                </label>
                                {tier.waitlistEnabled ? (
                                  <span className="px-2 py-0.5 rounded text-[10px] font-mono uppercase bg-amber-50 text-amber-800 border border-amber-300 font-bold">
                                    Queue Active When Sold Out
                                  </span>
                                ) : (
                                  <span className="px-2 py-0.5 rounded text-[10px] font-mono uppercase bg-stone-100 text-stone-500 font-bold">
                                    Off
                                  </span>
                                )}
                              </div>
                              <p className="text-[11px] text-stone-500 leading-snug">
                                Automatically queue fans when sold out. If tickets become available through cancellations or capacity increases, purchase offers are automatically issued in FIFO order.
                              </p>
                              {tier.id && (tier.waitlistWaitingCount !== undefined || tier.waitlistOfferedCount !== undefined) ? (
                                <div className="flex items-center gap-3 pt-1 text-[11px] font-mono text-stone-700">
                                  <span>Waiting: <strong className="text-stone-900">{tier.waitlistWaitingCount || 0}</strong></span>
                                  <span>Active Offers: <strong className="text-amber-700">{tier.waitlistOfferedCount || 0}</strong></span>
                                </div>
                              ) : null}
                            </div>
                            <button
                              type="button"
                              role="switch"
                              aria-checked={Boolean(tier.waitlistEnabled)}
                              onClick={() => {
                                updateTier(tier.tempId, 'waitlistEnabled', !tier.waitlistEnabled);
                              }}
                              className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                                tier.waitlistEnabled ? 'bg-amber-600' : 'bg-stone-300'
                              }`}
                            >
                              <span
                                className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                                  tier.waitlistEnabled ? 'translate-x-5' : 'translate-x-0'
                                }`}
                              />
                            </button>
                          </div>

                          {/* Tier Financial Breakdown Box */}
                          <div className="p-3 rounded-lg bg-white border border-stone-200 text-[11px] font-mono space-y-1">
                            <div className="flex items-center justify-between text-stone-600">
                              <span>Buyer Total (incl. processing):</span>
                              <span className="font-bold text-stone-900">{formatCents(tierEarnings.buyerTotalInCents)}</span>
                            </div>
                            <div className="flex items-center justify-between text-stone-600">
                              <span>Organizer Retains / Ticket:</span>
                              <span className="font-bold text-emerald-600">{formatCents(tierEarnings.organizerEarningsInCents)}</span>
                            </div>
                            <div className="flex items-center justify-between pt-1 border-t border-stone-100 text-stone-900 font-bold">
                              <span>Projected Sold Out Earnings:</span>
                              <span className="text-emerald-700 font-extrabold">{formatCents(tierEarnings.projectedEarningsInCents)}</span>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Admission Policies & Door Rules */}
                <div className="pt-6 border-t border-stone-200 space-y-4">
                  <div>
                    <h3 className="text-sm font-display font-black text-stone-900 uppercase tracking-tight">
                      Attendee Guidelines & Door Policies
                    </h3>
                    <p className="text-xs text-stone-500 mt-0.5 font-sans">
                      Clear admission rules displayed to attendees on the checkout and event pages.
                    </p>
                  </div>

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

                {/* Step Navigation Actions */}
                <div className="pt-6 border-t border-stone-200 flex items-center justify-between">
                  <button
                    type="button"
                    onClick={handlePrevStep}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-stone-300 bg-white hover:bg-stone-100 text-stone-700 font-mono text-xs font-semibold transition-colors shadow-2xs"
                  >
                    <ChevronLeft className="w-4 h-4" />
                    <span>Back: Date & Location</span>
                  </button>

                  <button
                    type="button"
                    onClick={handleNextStep}
                    className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-stone-900 hover:bg-black text-white font-mono text-xs font-semibold uppercase tracking-wider transition-colors shadow-2xs"
                  >
                    <span>Next: Discovery Preview</span>
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}

            {/* STEP 4: DISCOVERY PREVIEW & PUBLISH */}
            {currentStep === 4 && (
              <div className="bg-white rounded-xl border border-stone-200/90 p-6 sm:p-8 space-y-6 shadow-xs">
                <div>
                  <div className="flex items-center gap-2 text-stone-500 text-xs font-mono uppercase tracking-wider font-semibold">
                    <span>Step 4 of 4</span>
                    <span>•</span>
                    <span>Final Verification & Discovery Appearance</span>
                  </div>
                  <h2 className="text-xl sm:text-2xl font-display font-black text-stone-900 uppercase tracking-tight mt-1">
                    Discovery Preview
                  </h2>
                  <p className="text-xs text-stone-500 mt-1 font-sans">
                    Review your public discovery card and recurrence schedule before publishing live to Outside.vip catalogue.
                  </p>
                </div>

                {/* 1. Page Settings & Access Control */}
                <div className="p-5 rounded-xl border border-stone-200 bg-[#FAF8F5] space-y-4">
                  <div className="flex items-center gap-2">
                    <Shield className="w-4 h-4 text-stone-700" />
                    <span className="font-display font-black text-sm uppercase text-stone-900">
                      Page & Access Settings
                    </span>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {/* Show on Explore */}
                    <div className="p-4 rounded-lg bg-white border border-stone-200 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-mono font-bold uppercase text-stone-900 flex items-center gap-1.5">
                          <Globe className="w-3.5 h-3.5 text-stone-600" />
                          <span>Show on Explore</span>
                        </span>
                        <label className="relative inline-flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            checked={showOnExplore}
                            onChange={(e) => {
                              setShowOnExplore(e.target.checked);
                              setHasUnsavedChanges(true);
                            }}
                            className="sr-only peer"
                          />
                          <div className="w-9 h-5 bg-stone-300 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-stone-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-stone-900"></div>
                        </label>
                      </div>
                      <p className="text-[11px] text-stone-500 font-sans leading-normal">
                        When enabled, published occurrences appear in Outside.vip search and discovery catalogue. When disabled, the event is accessible only via direct link.
                      </p>
                    </div>

                    {/* Hide Guest Count */}
                    <div className="p-4 rounded-lg bg-white border border-stone-200 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-mono font-bold uppercase text-stone-900 flex items-center gap-1.5">
                          <Users className="w-3.5 h-3.5 text-stone-600" />
                          <span>Hide Guest Count</span>
                        </span>
                        <label className="relative inline-flex items-center cursor-pointer">
                          <input
                            type="checkbox"
                            checked={hideGuestCount}
                            onChange={(e) => {
                              setHideGuestCount(e.target.checked);
                              setHasUnsavedChanges(true);
                            }}
                            className="sr-only peer"
                          />
                          <div className="w-9 h-5 bg-stone-300 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-stone-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-stone-900"></div>
                        </label>
                      </div>
                      <p className="text-[11px] text-stone-500 font-sans leading-normal">
                        Keep attendee numbers confidential. When enabled, confirmed guest counters are omitted from the public event page.
                      </p>
                    </div>
                  </div>

                  {/* Password Protection */}
                  <div className="p-4 rounded-lg bg-white border border-stone-200 space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Lock className="w-4 h-4 text-stone-700" />
                        <div>
                          <span className="text-xs font-mono font-bold uppercase text-stone-900 block">
                            Password-Protected Event
                          </span>
                          <span className="text-[11px] text-stone-500 font-sans">
                            Require an access password before unlocking full event details and ticket purchasing.
                          </span>
                        </div>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer shrink-0">
                        <input
                          type="checkbox"
                          checked={isPasswordProtected}
                          onChange={(e) => {
                            setIsPasswordProtected(e.target.checked);
                            setHasUnsavedChanges(true);
                          }}
                          className="sr-only peer"
                        />
                        <div className="w-9 h-5 bg-stone-300 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-stone-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-stone-900"></div>
                      </label>
                    </div>

                    {isPasswordProtected && (
                      <div className="pt-2 border-t border-stone-100 max-w-md">
                        <label className="block text-xs font-mono uppercase text-stone-700 font-bold mb-1.5">
                          {isEditing && existingData?.event?.isPasswordProtected
                            ? 'Update Password (leave blank to keep current)'
                            : 'Set Access Password'} <span className="text-rose-600">*</span>
                        </label>
                        <div className="relative">
                          <input
                            type={showPasswordText ? 'text' : 'password'}
                            placeholder={
                              isEditing && existingData?.event?.isPasswordProtected
                                ? '•••••••• (Enter new password to change)'
                                : 'Enter secret event password'
                            }
                            value={password}
                            onChange={(e) => {
                              setPassword(e.target.value);
                              setHasUnsavedChanges(true);
                            }}
                            className="w-full px-3.5 py-2.5 rounded-lg bg-[#FAF8F5] border border-stone-300 text-stone-900 placeholder-stone-400 text-xs focus:outline-none focus:border-stone-900 focus:bg-white transition-colors font-mono pr-10"
                          />
                          <button
                            type="button"
                            onClick={() => setShowPasswordText(!showPasswordText)}
                            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-stone-500 hover:text-stone-800 p-1"
                          >
                            {showPasswordText ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                          </button>
                        </div>
                        <p className="text-[10px] font-mono text-stone-500 mt-1">
                          Protected with secure bcrypt encryption. Never exposed in URLs or frontend code.
                        </p>
                      </div>
                    )}
                  </div>
                </div>

                {/* 2. Optional YouTube Video */}
                <div className="p-5 rounded-xl border border-stone-200 bg-[#FAF8F5] space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Video className="w-4 h-4 text-stone-700" />
                      <span className="font-display font-black text-sm uppercase text-stone-900">
                        Featured YouTube Video (Optional)
                      </span>
                    </div>
                    {detectedVideoId && (
                      <span className="px-2 py-0.5 rounded text-[10px] font-mono uppercase bg-emerald-100 text-emerald-800 font-bold flex items-center gap-1">
                        <Check className="w-3 h-3" />
                        <span>Valid YouTube Link</span>
                      </span>
                    )}
                  </div>

                  <p className="text-xs text-stone-500 font-sans">
                    Embed an official festival aftermovie, DJ set, speaker keynote, or promotional teaser on your event page.
                  </p>

                  <div className="max-w-xl">
                    <div className="flex gap-2">
                      <input
                        type="url"
                        placeholder="https://www.youtube.com/watch?v=... or https://youtu.be/..."
                        value={youtubeVideoUrl}
                        onChange={(e) => {
                          setYoutubeVideoUrl(e.target.value);
                          setHasUnsavedChanges(true);
                        }}
                        className="flex-1 px-3.5 py-2.5 rounded-lg bg-white border border-stone-300 text-stone-900 placeholder-stone-400 text-xs focus:outline-none focus:border-stone-900 transition-colors font-mono"
                      />
                      {youtubeVideoUrl && (
                        <button
                          type="button"
                          onClick={() => {
                            setYoutubeVideoUrl('');
                            setHasUnsavedChanges(true);
                          }}
                          className="px-3 py-2 rounded-lg bg-stone-200 hover:bg-stone-300 text-stone-700 text-xs font-mono font-semibold transition-colors"
                        >
                          Clear
                        </button>
                      )}
                    </div>
                    {youtubeVideoUrl && !detectedVideoId && (
                      <p className="mt-1.5 text-[11px] font-mono text-rose-600 flex items-center gap-1">
                        <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                        <span>Please enter a valid YouTube video URL (watch, youtu.be, or shorts).</span>
                      </p>
                    )}
                  </div>

                  {detectedVideoId && (
                    <div className="mt-3 max-w-md aspect-video rounded-lg overflow-hidden border border-stone-300 bg-black">
                      <iframe
                        src={getYouTubeEmbedUrl(detectedVideoId)}
                        title="YouTube Video Preview"
                        className="w-full h-full border-0"
                        allow="accelerometer; encrypted-media; gyroscope; picture-in-picture"
                        allowFullScreen
                      />
                    </div>
                  )}
                </div>

                {/* 3. Event Features Section (Performers, Sponsors, Speakers, Hosts, and More) */}
                <div className="p-5 rounded-xl border border-stone-200 bg-[#FAF8F5] space-y-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="flex items-center gap-2">
                        <Sparkles className="w-4 h-4 text-stone-700" />
                        <span className="font-display font-black text-sm uppercase text-stone-900">
                          Event Features & Lineup ({features.length})
                        </span>
                      </div>
                      <p className="text-xs text-stone-500 mt-0.5 font-sans">
                        Highlight headline performers, keynote speakers, event hosts, brand sponsors, or other features.
                      </p>
                    </div>

                    {!isAddingFeature && (
                      <button
                        type="button"
                        onClick={() => setIsAddingFeature(true)}
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-stone-900 hover:bg-black text-white font-mono text-xs font-semibold shadow-2xs transition-colors"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        <span>Add Feature</span>
                      </button>
                    )}
                  </div>

                  {/* Add Feature Form */}
                  {isAddingFeature && (
                    <div className="p-4 rounded-xl border border-stone-300 bg-white space-y-3 shadow-xs">
                      <div className="text-xs font-mono font-bold uppercase text-stone-900 pb-1 border-b border-stone-100 flex items-center justify-between">
                        <span>New Event Feature</span>
                        <button
                          type="button"
                          onClick={() => setIsAddingFeature(false)}
                          className="text-stone-400 hover:text-stone-700"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <label className="block text-[11px] font-mono uppercase text-stone-700 font-bold mb-1">
                            Name <span className="text-rose-600">*</span>
                          </label>
                          <input
                            type="text"
                            placeholder="e.g. DJ Maphorisa, Red Bull, Dr. Jane Doe"
                            value={newFeatureName}
                            onChange={(e) => setNewFeatureName(e.target.value)}
                            className="w-full px-3 py-2 rounded-lg bg-[#FAF8F5] border border-stone-300 text-stone-900 text-xs focus:outline-none focus:border-stone-900 font-sans"
                          />
                        </div>

                        <div>
                          <label className="block text-[11px] font-mono uppercase text-stone-700 font-bold mb-1">
                            Category / Type <span className="text-rose-600">*</span>
                          </label>
                          <select
                            value={newFeatureType}
                            onChange={(e) => setNewFeatureType(e.target.value as EventFeatureType)}
                            className="w-full px-3 py-2 rounded-lg bg-[#FAF8F5] border border-stone-300 text-stone-900 text-xs focus:outline-none focus:border-stone-900 font-mono cursor-pointer"
                          >
                            <option value="PERFORMER">Performer / Artist</option>
                            <option value="SPONSOR">Sponsor / Partner</option>
                            <option value="SPEAKER">Speaker / Panelist</option>
                            <option value="HOST">Host / MC</option>
                            <option value="OTHER">Other Special Feature</option>
                          </select>
                        </div>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <label className="block text-[11px] font-mono uppercase text-stone-700 font-bold mb-1">
                            Image / Logo URL
                          </label>
                          <input
                            type="url"
                            placeholder="https://..."
                            value={newFeatureImage}
                            onChange={(e) => setNewFeatureImage(e.target.value)}
                            className="w-full px-3 py-2 rounded-lg bg-[#FAF8F5] border border-stone-300 text-stone-900 text-xs focus:outline-none focus:border-stone-900 font-mono"
                          />
                        </div>

                        <div>
                          <label className="block text-[11px] font-mono uppercase text-stone-700 font-bold mb-1">
                            Or Upload Local Photo / Logo
                          </label>
                          <label className="w-full px-3 py-2 rounded-lg bg-[#FAF8F5] border border-dashed border-stone-300 hover:border-stone-900 text-stone-700 text-xs font-mono flex items-center justify-center gap-1.5 cursor-pointer transition-colors">
                            {isUploadingFeatureImage ? (
                              <>
                                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                                <span>Uploading...</span>
                              </>
                            ) : (
                              <>
                                <Upload className="w-3.5 h-3.5" />
                                <span>Upload Logo (JPEG, PNG, WebP)</span>
                              </>
                            )}
                            <input
                              type="file"
                              accept="image/jpeg,image/png,image/webp"
                              disabled={isUploadingFeatureImage}
                              onChange={handleFeatureImageFileChange}
                              className="sr-only"
                            />
                          </label>
                          {featureUploadError && (
                            <p className="text-[10px] text-rose-600 mt-1 font-mono">{featureUploadError}</p>
                          )}
                        </div>
                      </div>

                      <div>
                        <label className="block text-[11px] font-mono uppercase text-stone-700 font-bold mb-1">
                          Short Description / Role (Optional)
                        </label>
                        <input
                          type="text"
                          placeholder="e.g. Amapiano Pioneer, Official Energy Drink Partner, Keynote on AI"
                          value={newFeatureDesc}
                          onChange={(e) => setNewFeatureDesc(e.target.value)}
                          className="w-full px-3 py-2 rounded-lg bg-[#FAF8F5] border border-stone-300 text-stone-900 text-xs focus:outline-none focus:border-stone-900 font-sans"
                        />
                      </div>

                      <div className="flex justify-end gap-2 pt-1">
                        <button
                          type="button"
                          onClick={() => setIsAddingFeature(false)}
                          className="px-3 py-1.5 rounded-lg border border-stone-300 bg-white hover:bg-stone-100 text-stone-700 font-mono text-xs font-semibold"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={addFeature}
                          disabled={!newFeatureName.trim() || isUploadingFeatureImage}
                          className="px-4 py-1.5 rounded-lg bg-stone-900 hover:bg-black text-white font-mono text-xs font-semibold disabled:opacity-40"
                        >
                          Save Feature
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Features List */}
                  {features.length > 0 ? (
                    <div className="space-y-2">
                      {features.map((feat, idx) => (
                        <div
                          key={feat.name + idx}
                          className="p-3 rounded-lg bg-white border border-stone-200 flex flex-wrap items-center justify-between gap-3 text-xs"
                        >
                          <div className="flex items-center gap-3 min-w-0">
                            {feat.imageUrl ? (
                              <img
                                src={feat.imageUrl}
                                alt={feat.name}
                                className="w-10 h-10 rounded-full object-cover border border-stone-200 shrink-0"
                              />
                            ) : (
                              <div className="w-10 h-10 rounded-full bg-stone-100 border border-stone-200 flex items-center justify-center font-mono font-bold text-stone-600 shrink-0">
                                {feat.name.charAt(0).toUpperCase()}
                              </div>
                            )}
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="font-bold text-stone-900 truncate">{feat.name}</span>
                                <span className="px-2 py-0.5 rounded text-[10px] font-mono font-bold uppercase bg-stone-100 text-stone-700 border border-stone-200">
                                  {feat.type}
                                </span>
                              </div>
                              {feat.description && (
                                <p className="text-stone-500 text-[11px] truncate font-sans">{feat.description}</p>
                              )}
                            </div>
                          </div>

                          <div className="flex items-center gap-1.5 shrink-0">
                            <button
                              type="button"
                              disabled={idx === 0}
                              onClick={() => moveFeature(idx, 'up')}
                              title="Move up"
                              className="p-1 rounded text-stone-500 hover:text-stone-900 disabled:opacity-30 disabled:cursor-not-allowed"
                            >
                              <ArrowUp className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              disabled={idx === features.length - 1}
                              onClick={() => moveFeature(idx, 'down')}
                              title="Move down"
                              className="p-1 rounded text-stone-500 hover:text-stone-900 disabled:opacity-30 disabled:cursor-not-allowed"
                            >
                              <ArrowDown className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => removeFeature(idx)}
                              title="Delete feature"
                              className="p-1 rounded text-rose-500 hover:text-rose-700"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    !isAddingFeature && (
                      <div className="p-4 rounded-lg bg-white border border-stone-200 text-center text-xs font-mono text-stone-500">
                        No features added yet. Add performers, speakers, or sponsors to highlight them on the event page.
                      </div>
                    )
                  )}
                </div>

                {/* 4. Live Discovery Preview */}
                <div className="pt-2">
                  <div className="text-xs font-mono uppercase tracking-wider text-stone-500 font-bold mb-3">
                    Public Discovery Card Preview
                  </div>
                  <div className="max-w-sm mx-auto">
                    <div className="rounded-xl overflow-hidden border border-stone-200 bg-white text-stone-900 shadow-md p-3.5 space-y-3">
                      <div className="aspect-[16/10] relative overflow-hidden rounded-lg bg-stone-900">
                        <img
                          src={coverImageUrl}
                          alt="Cover"
                          className="w-full h-full object-cover"
                        />
                        <div className="absolute top-2.5 right-2.5 px-2 py-0.5 rounded bg-black/80 text-white font-mono text-[10px] font-bold uppercase">
                          {category}
                        </div>
                        {isRecurring && (
                          <div className="absolute bottom-2.5 left-2.5 px-2 py-0.5 rounded bg-blue-900/90 text-white font-mono text-[10px] font-bold uppercase flex items-center gap-1">
                            <Repeat className="w-3 h-3" />
                            <span>Series</span>
                          </div>
                        )}
                        {isPasswordProtected && (
                          <div className="absolute top-2.5 left-2.5 px-2 py-0.5 rounded bg-amber-600/95 text-white font-mono text-[10px] font-bold uppercase flex items-center gap-1">
                            <Lock className="w-3 h-3" />
                            <span>Password Protected</span>
                          </div>
                        )}
                        {!showOnExplore && (
                          <div className="absolute bottom-2.5 right-2.5 px-2 py-0.5 rounded bg-stone-800/90 text-stone-300 font-mono text-[10px] font-bold uppercase">
                            Direct Link Only
                          </div>
                        )}
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
                        {features.length > 0 && (
                          <div className="pt-2 border-t border-stone-100 flex flex-wrap gap-1">
                            {features.slice(0, 3).map((f) => (
                              <span key={f.name} className="px-1.5 py-0.5 rounded bg-stone-100 text-[10px] font-mono text-stone-700">
                                {f.name}
                              </span>
                            ))}
                            {features.length > 3 && (
                              <span className="text-[10px] font-mono text-stone-400 self-center">
                                +{features.length - 3} more
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>

                {/* Recurring Series Summary List (if recurring) */}
                {isRecurring && (
                  <div className="p-5 rounded-xl border border-stone-200 bg-[#FAF8F5] space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Layers className="w-4 h-4 text-stone-700" />
                        <span className="font-display font-black text-sm uppercase text-stone-900">
                          Recurring Series Occurrences ({occurrenceSchedulePreview.length})
                        </span>
                      </div>
                      <span className="px-2.5 py-0.5 rounded text-[10px] font-mono uppercase bg-blue-100 text-blue-800 font-bold">
                        {recurrenceFrequency}
                      </span>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-48 overflow-y-auto">
                      {occurrenceSchedulePreview.map((occ) => (
                        <div
                          key={occ.index}
                          className="p-2.5 rounded-lg bg-white border border-stone-200 text-xs font-mono flex items-center justify-between"
                        >
                          <div className="flex items-center gap-2">
                            <span className="w-5 text-stone-400 font-bold">#{occ.index}</span>
                            <span className="font-semibold text-stone-800">
                              {occ.startAt.toLocaleDateString('en-US', {
                                weekday: 'short',
                                month: 'short',
                                day: 'numeric',
                              })}
                            </span>
                          </div>
                          <span className="text-stone-500 text-[10px]">
                            {occ.startAt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Final Checklist Card */}
                <div className="p-4 rounded-xl border border-stone-200 bg-stone-50 space-y-2 text-xs font-mono">
                  <div className="font-bold text-stone-900 uppercase">Pre-Flight Verification</div>
                  <div className="flex items-center gap-2 text-stone-600">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                    <span>Title: <strong>{title || 'Draft'}</strong></span>
                  </div>
                  <div className="flex items-center gap-2 text-stone-600">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                    <span>Venue: <strong>{venueName}, {city}</strong></span>
                  </div>
                  <div className="flex items-center gap-2 text-stone-600">
                    <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                    <span>Tiers: <strong>{ticketTiers.length} configured</strong> (Total Capacity: {ticketTiers.reduce((acc, t) => acc + (Number(t.totalCapacity) || 0), 0)})</span>
                  </div>
                </div>

                {/* Step Navigation Actions */}
                <div className="pt-6 border-t border-stone-200 flex flex-wrap items-center justify-between gap-3">
                  <button
                    type="button"
                    onClick={handlePrevStep}
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg border border-stone-300 bg-white hover:bg-stone-100 text-stone-700 font-mono text-xs font-semibold transition-colors shadow-2xs"
                  >
                    <ChevronLeft className="w-4 h-4" />
                    <span>Back: Tickets & Policies</span>
                  </button>

                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => saveMutation.mutate({ publish: false })}
                      disabled={saveMutation.isPending || isUploadingImage}
                      className="px-4 py-2.5 rounded-lg border border-stone-300 bg-white hover:bg-stone-100 text-stone-900 font-mono text-xs font-semibold transition-colors shadow-2xs disabled:opacity-50"
                    >
                      {saveMutation.isPending ? 'Saving...' : 'Save Draft'}
                    </button>

                    <button
                      type="button"
                      onClick={() => saveMutation.mutate({ publish: true })}
                      disabled={saveMutation.isPending || isUploadingImage}
                      className="inline-flex items-center gap-2 px-6 py-2.5 rounded-lg bg-stone-900 hover:bg-black text-white font-mono text-xs font-semibold uppercase tracking-wider transition-colors shadow-2xs disabled:opacity-50"
                    >
                      <Globe className="w-4 h-4" />
                      <span>
                        {saveMutation.isPending
                          ? 'Publishing...'
                          : isRecurring && !isEditing
                          ? `Publish All ${occurrenceSchedulePreview.length} Occurrences`
                          : currentStatus === 'PUBLISHED'
                          ? 'Update Live'
                          : 'Publish Live'}
                      </span>
                    </button>
                  </div>
                </div>
              </div>
            )}
          </main>
        </div>
      </div>

      {/* Cancellation Modal */}
      {showCancelModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs">
          <div className="bg-white rounded-xl border border-stone-200 max-w-md w-full p-6 space-y-4 shadow-xl">
            <div className="flex items-center gap-3 text-rose-600">
              <Ban className="w-6 h-6 shrink-0" />
              <h3 className="font-display font-black text-lg text-stone-900 uppercase">
                {cancelSeriesMode ? 'Cancel Recurring Series' : 'Cancel Event Occurrence'}
              </h3>
            </div>
            <p className="text-xs text-stone-600 font-sans leading-relaxed">
              {cancelSeriesMode
                ? 'Are you sure you want to cancel the entire recurring series? All future scheduled occurrences will be marked as cancelled.'
                : 'Are you sure you want to cancel this specific event occurrence? Other occurrences in this series will remain active.'}
            </p>
            <div>
              <label className="block text-xs font-mono uppercase text-stone-700 font-bold mb-1">
                Reason for Cancellation (Optional)
              </label>
              <textarea
                rows={3}
                placeholder="e.g. Severe weather conditions, venue scheduling change..."
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-[#FAF8F5] border border-stone-300 text-xs font-sans text-stone-900 focus:outline-none focus:border-stone-900"
              />
            </div>
            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setShowCancelModal(false)}
                className="px-4 py-2 rounded-lg border border-stone-300 bg-white hover:bg-stone-100 text-stone-700 text-xs font-mono font-semibold"
              >
                Go Back
              </button>
              <button
                type="button"
                onClick={() => cancelMutation.mutate()}
                disabled={cancelMutation.isPending}
                className="px-4 py-2 rounded-lg bg-rose-600 hover:bg-rose-700 text-white text-xs font-mono font-semibold uppercase tracking-wider disabled:opacity-50"
              >
                {cancelMutation.isPending ? 'Cancelling...' : 'Confirm Cancellation'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
