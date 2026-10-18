import { PrismaClient, Role, EventCategory, EventStatus, TicketTierStatus, OrderStatus, TicketStatus, PaymentProvider } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Starting Outside.vip database seed...');

  // Clean existing tables (in order of relations)
  await prisma.checkInLog.deleteMany();
  await prisma.paymentTransaction.deleteMany();
  await prisma.ticketReservation.deleteMany();
  await prisma.ticket.deleteMany();
  await prisma.orderItem.deleteMany();
  await prisma.order.deleteMany();
  await prisma.ticketTier.deleteMany();
  await prisma.event.deleteMany();
  await prisma.organizerProfile.deleteMany();
  await prisma.user.deleteMany();

  // Create Users
  const passwordHash = await bcrypt.hash('Outside2026!', 10);

  const admin = await prisma.user.create({
    data: {
      email: 'admin@outside.vip',
      name: 'Outside Admin',
      passwordHash,
      role: Role.ADMIN,
      avatarUrl: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=400&q=80',
    },
  });

  const organizerUser = await prisma.user.create({
    data: {
      email: 'sol@outside.vip',
      name: 'Sol Experience Group',
      passwordHash,
      role: Role.ORGANIZER,
      avatarUrl: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?auto=format&fit=crop&w=400&q=80',
    },
  });

  const attendee = await prisma.user.create({
    data: {
      email: 'alex@outside.vip',
      name: 'Alex Mwangi',
      passwordHash,
      role: Role.ATTENDEE,
      avatarUrl: 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?auto=format&fit=crop&w=400&q=80',
    },
  });

  // Create Organizer Profile
  const organizerProfile = await prisma.organizerProfile.create({
    data: {
      userId: organizerUser.id,
      displayName: 'Sol Collective & Sound',
      slug: 'sol-collective',
      bio: 'Pioneering East African electronic, afro-house, and high-energy live festival experiences. Curating unforgettable nights under the stars.',
      websiteUrl: 'https://solexperience.co',
      instagramHandle: '@solcollective',
      twitterHandle: '@solcollective',
      logoUrl: 'https://images.unsplash.com/photo-1516450360452-9312f5e86fc7?auto=format&fit=crop&w=300&q=80',
    },
  });

  console.log(`✅ Created users & organizer: ${organizerProfile.displayName}`);

  // Event 1: SOL FEST - Baobab Edition
  const event1 = await prisma.event.create({
    data: {
      slug: 'sol-fest-baobab-edition-2026',
      organizerId: organizerUser.id,
      title: 'SOL FEST: Under The Baobab Tree',
      tagline: 'A 14-hour open-air soundscape featuring global headliners and sonic innovators',
      description: `Outside.vip presents the legendary Sol Fest Baobab Edition. Experience the fusion of deep afro-house, live instrumentation, and immersive visual architecture in the heart of the savannah.

Featuring dual stages, artisan food villages, curated mixology lounges, and 360-degree surround spatial audio.

Lineup:
• Sona & Black Motion (Headliners)
• Sun-El Musician Live
• Coco EM & Suraj
• Special Secret Guest (Berlin)`,
      category: EventCategory.FESTIVAL,
      status: EventStatus.PUBLISHED,
      coverImageUrl: 'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?auto=format&fit=crop&w=1600&q=85',
      thumbnailUrl: 'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?auto=format&fit=crop&w=400&q=80',
      venueName: 'The Baobab Amphitheatre, Kilifi Creek',
      venueAddress: 'Bofa Beach Road, Kilifi',
      city: 'Kilifi',
      country: 'Kenya',
      latitude: -3.6307,
      longitude: 39.8499,
      startAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 7), // 7 days from now
      endAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 7 + 1000 * 60 * 60 * 14),
      timezone: 'Africa/Nairobi',
      ageRestriction: '21+',
      dressCode: 'Savannah Chic / Avant-Garde',
      isFeatured: true,
      ticketTiers: {
        create: [
          {
            name: 'Early Bird GA',
            description: 'Full 14-hour festival access, general lawn entry, and shuttle transport from Kilifi town center.',
            priceInCents: 3500, // $35.00
            currency: 'USD',
            totalCapacity: 500,
            soldQuantity: 500,
            status: TicketTierStatus.SOLD_OUT,
          },
          {
            name: 'General Admission',
            description: 'Standard access to main stages, food village, and art installations.',
            priceInCents: 5000, // $50.00
            currency: 'USD',
            totalCapacity: 1500,
            soldQuantity: 340,
            status: TicketTierStatus.ACTIVE,
          },
          {
            name: 'VIP Creek Terrace',
            description: 'Dedicated express entrance, elevated creek-view deck, complimentary signature welcome drinks, private bar & luxury restrooms.',
            priceInCents: 12000, // $120.00
            currency: 'USD',
            totalCapacity: 300,
            soldQuantity: 185,
            status: TicketTierStatus.ACTIVE,
          },
          {
            name: 'Backstage & Artist Pass',
            description: 'All-inclusive hospitality, artist green room access, soundcheck access, and private concierge.',
            priceInCents: 25000, // $250.00
            currency: 'USD',
            totalCapacity: 50,
            soldQuantity: 28,
            status: TicketTierStatus.ACTIVE,
          },
        ],
      },
    },
    include: {
      ticketTiers: true,
    },
  });

  // Event 2: Warehouse Rave
  const event2 = await prisma.event.create({
    data: {
      slug: 'sub-terrain-industrial-warehouse-004',
      organizerId: organizerUser.id,
      title: 'SUB-TERRAIN: Industrial Warehouse Session 004',
      tagline: 'Raw concrete, red strobes, and relentless underground techno',
      description: `SUB-TERRAIN returns to the abandoned Railway Godown for an uncompromising night of minimal techno, dark wave, and modular synthesis. Strictly no cameras on the dancefloor.

Lineup:
• Umwelt (Voitax / Lyon)
• KMRU (Live Ambient Drone Set)
• Frankie & The Monks`,
      category: EventCategory.NIGHTLIFE,
      status: EventStatus.PUBLISHED,
      coverImageUrl: 'https://images.unsplash.com/photo-1516450360452-9312f5e86fc7?auto=format&fit=crop&w=1600&q=85',
      thumbnailUrl: 'https://images.unsplash.com/photo-1516450360452-9312f5e86fc7?auto=format&fit=crop&w=400&q=80',
      venueName: 'The Railway Shed 4',
      venueAddress: 'Haile Selassie Avenue, Industrial Area',
      city: 'Nairobi',
      country: 'Kenya',
      latitude: -1.2921,
      longitude: 36.8219,
      startAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 14), // 14 days from now
      endAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 14 + 1000 * 60 * 60 * 9),
      timezone: 'Africa/Nairobi',
      ageRestriction: '18+',
      dressCode: 'All Black / Industrial Minimal',
      isFeatured: true,
      ticketTiers: {
        create: [
          {
            name: 'First Release',
            description: 'Admission before 11:00 PM.',
            priceInCents: 2000,
            currency: 'USD',
            totalCapacity: 200,
            soldQuantity: 180,
            status: TicketTierStatus.ACTIVE,
          },
          {
            name: 'Final Release',
            description: 'All-night access to the main floor.',
            priceInCents: 3500,
            currency: 'USD',
            totalCapacity: 400,
            soldQuantity: 62,
            status: TicketTierStatus.ACTIVE,
          },
        ],
      },
    },
    include: {
      ticketTiers: true,
    },
  });

  // Event 3: Tech & Culture Summit
  const event3 = await prisma.event.create({
    data: {
      slug: 'outside-synapse-future-tech-summit',
      organizerId: organizerUser.id,
      title: 'SYNAPSE: Emerging Tech & Creative Media Summit',
      tagline: 'Where AI, Web3, Creative Direction, and African venture collide',
      description: `SYNAPSE brings together 500 elite founders, design leaders, engineers, and digital artists for keynote debates, interactive demos, and a high-energy rooftop networking soiree overlooking Nairobi's skyline.`,
      category: EventCategory.TECH,
      status: EventStatus.PUBLISHED,
      coverImageUrl: 'https://images.unsplash.com/photo-1540575467063-178a50c2df87?auto=format&fit=crop&w=1600&q=85',
      thumbnailUrl: 'https://images.unsplash.com/photo-1540575467063-178a50c2df87?auto=format&fit=crop&w=400&q=80',
      venueName: 'The Alchemist & Rooftop Studio',
      venueAddress: 'Parklands Road, Westlands',
      city: 'Nairobi',
      country: 'Kenya',
      latitude: -1.2635,
      longitude: 36.8028,
      startAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 21),
      endAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 21 + 1000 * 60 * 60 * 10),
      timezone: 'Africa/Nairobi',
      ageRestriction: 'All Ages',
      dressCode: 'Smart Casual / Future Forward',
      isFeatured: false,
      ticketTiers: {
        create: [
          {
            name: 'Founder & Builder Pass',
            description: 'Access to keynote sessions, workshop labs, and rooftop mixer.',
            priceInCents: 8500,
            currency: 'USD',
            totalCapacity: 300,
            soldQuantity: 110,
            status: TicketTierStatus.ACTIVE,
          },
          {
            name: 'VIP Investor Pass',
            description: 'Priority seating, private breakfast with speakers, and exclusive investor salon access.',
            priceInCents: 20000,
            currency: 'USD',
            totalCapacity: 100,
            soldQuantity: 45,
            status: TicketTierStatus.ACTIVE,
          },
        ],
      },
    },
    include: {
      ticketTiers: true,
    },
  });

  // Event 4: Alte Cruise Sunset
  const event4 = await prisma.event.create({
    data: {
      slug: 'alte-cruise-sunset-rooftop-session',
      organizerId: organizerUser.id,
      title: 'ALTE CRUISE: Sunset Rooftop Session',
      tagline: 'Golden hour melodies, west African alté, afro-fusion, and curated craft cocktails',
      description: `Outside.vip brings the iconic Alté Cruise series back to the capital. Expect seamless transitions between neo-afrobeats, highlife, Amapiano blends, and ambient electronics as the sun sinks over the skyline.

Featuring:
• Native Sound System
• DJ Ayane & Friends
• Special live saxophone accompaniment
• Curated mezcal & botanical cocktail pop-ups`,
      category: EventCategory.MUSIC,
      status: EventStatus.PUBLISHED,
      coverImageUrl: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?auto=format&fit=crop&w=1600&q=85',
      thumbnailUrl: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?auto=format&fit=crop&w=400&q=80',
      venueName: 'The GTC Horizon Sky Lounge',
      venueAddress: 'Waiyaki Way, Westlands',
      city: 'Nairobi',
      country: 'Kenya',
      latitude: -1.2683,
      longitude: 36.8055,
      startAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 3), // 3 days from now
      endAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 3 + 1000 * 60 * 60 * 6),
      timezone: 'Africa/Nairobi',
      ageRestriction: '21+',
      dressCode: 'Retro Glam / Elevated Streetwear',
      isFeatured: true,
      ticketTiers: {
        create: [
          {
            name: 'Sunset Admission',
            description: 'Entry before 6:30 PM with 1 complimentary signature spritz.',
            priceInCents: 2500,
            currency: 'USD',
            totalCapacity: 250,
            soldQuantity: 140,
            status: TicketTierStatus.ACTIVE,
          },
          {
            name: 'Reserved Table for 4',
            description: 'Dedicated lounge booth, bottle service credit, and charcuterie board.',
            priceInCents: 15000,
            currency: 'USD',
            totalCapacity: 25,
            soldQuantity: 18,
            status: TicketTierStatus.ACTIVE,
          },
        ],
      },
    },
    include: { ticketTiers: true },
  });

  // Event 5: Coastal Sundowner (Food & Drink)
  const event5 = await prisma.event.create({
    data: {
      slug: 'coastal-sundowner-diani-seafood',
      organizerId: organizerUser.id,
      title: 'COASTAL SUNDOWNER: Swahili Feast & Sound',
      tagline: 'Fresh Indian Ocean catch, tamarind cocktails, and barefoot acoustic rhythms',
      description: `A sensory culinary and musical journey on the white sands of Diani. Chef-curated charcoal grilled prawns, coconut crab curries, live percussion, and sunset beach bonfires.`,
      category: EventCategory.FOOD_DRINK,
      status: EventStatus.PUBLISHED,
      coverImageUrl: 'https://images.unsplash.com/photo-1555396273-367ea4eb4db5?auto=format&fit=crop&w=1600&q=85',
      thumbnailUrl: 'https://images.unsplash.com/photo-1555396273-367ea4eb4db5?auto=format&fit=crop&w=400&q=80',
      venueName: 'Nomad Beach Club Sandbank',
      venueAddress: 'Diani Beach Road',
      city: 'Diani',
      country: 'Kenya',
      latitude: -4.2778,
      longitude: 39.5894,
      startAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 10),
      endAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 10 + 1000 * 60 * 60 * 7),
      timezone: 'Africa/Nairobi',
      ageRestriction: 'All Ages',
      dressCode: 'Coastal Linen / Barefoot Chic',
      isFeatured: false,
      ticketTiers: {
        create: [
          {
            name: 'Tasting Pass & Entry',
            description: 'Access to beach lounge, live acoustic sets, and 4 culinary tasting tokens.',
            priceInCents: 4500,
            currency: 'USD',
            totalCapacity: 200,
            soldQuantity: 88,
            status: TicketTierStatus.ACTIVE,
          },
        ],
      },
    },
    include: { ticketTiers: true },
  });

  // Event 6: Savannah Cinema & Vinyl (Arts & Culture)
  const event6 = await prisma.event.create({
    data: {
      slug: 'savannah-cinema-vinyl-under-stars',
      organizerId: organizerUser.id,
      title: 'SAVANNAH CINEMA: African Classic Film & Vinyl',
      tagline: 'Open-air cinema projection, rare vinyl selections, and warm fire pits',
      description: `Experience classic and contemporary African cinema projected on a 40-foot outdoor screen overlooking the silhouette of acacia trees. Pre-show vinyl listening session powered by vintage Klipsch horn speakers.`,
      category: EventCategory.ARTS_CULTURE,
      status: EventStatus.PUBLISHED,
      coverImageUrl: 'https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?auto=format&fit=crop&w=1600&q=85',
      thumbnailUrl: 'https://images.unsplash.com/photo-1489599849927-2ee91cede3ba?auto=format&fit=crop&w=400&q=80',
      venueName: 'The Silo Wilds Amphitheatre',
      venueAddress: 'Magadi Road, Langata',
      city: 'Nairobi',
      country: 'Kenya',
      latitude: -1.3653,
      longitude: 36.7588,
      startAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 5),
      endAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 5 + 1000 * 60 * 60 * 5),
      timezone: 'Africa/Nairobi',
      ageRestriction: '18+',
      dressCode: 'Warm Safari Layers',
      isFeatured: false,
      ticketTiers: {
        create: [
          {
            name: 'Lawn Blanket Pass',
            description: 'Includes handwoven picnic mat, wireless headphones, and bottomless popcorn.',
            priceInCents: 1800,
            currency: 'USD',
            totalCapacity: 150,
            soldQuantity: 92,
            status: TicketTierStatus.ACTIVE,
          },
        ],
      },
    },
    include: { ticketTiers: true },
  });

  console.log(`✅ Created 6 diverse events: [${event1.title}], [${event2.title}], [${event3.title}], [${event4.title}], [${event5.title}], [${event6.title}]`);

  // Create sample confirmed order and tickets for Attendee Alex
  const vipTier = event1.ticketTiers.find((t) => t.name === 'VIP Creek Terrace')!;
  const order = await prisma.order.create({
    data: {
      orderNumber: 'OUT-2026-89412',
      userId: attendee.id,
      eventId: event1.id,
      status: OrderStatus.COMPLETED,
      customerEmail: attendee.email,
      customerName: attendee.name,
      customerPhone: '+254712345678',
      totalInCents: vipTier.priceInCents * 2,
      currency: 'USD',
      idempotencyKey: 'seed_idem_alex_vip_order_01',
      paymentProvider: PaymentProvider.STRIPE,
      paymentReference: 'cs_test_seed_session_alex_01',
      expiresAt: new Date(Date.now() + 1000 * 60 * 30),
      items: {
        create: [
          {
            ticketTierId: vipTier.id,
            quantity: 2,
            unitPriceInCents: vipTier.priceInCents,
            subtotalInCents: vipTier.priceInCents * 2,
          },
        ],
      },
      tickets: {
        create: [
          {
            ticketToken: 'tkt_sec_7a9f2e3b8c1d4e5f',
            eventId: event1.id,
            ticketTierId: vipTier.id,
            attendeeName: 'Alex Mwangi',
            attendeeEmail: 'alex@outside.vip',
            status: TicketStatus.ISSUED,
          },
          {
            ticketToken: 'tkt_sec_1d8c4e5f7a9f2e3b',
            eventId: event1.id,
            ticketTierId: vipTier.id,
            attendeeName: 'Zainab Wanjiru',
            attendeeEmail: 'zainab@outside.vip',
            status: TicketStatus.CHECKED_IN,
            checkedInAt: new Date(Date.now() - 1000 * 60 * 45), // Checked in 45 mins ago
            checkedInByUserId: admin.id,
          },
        ],
      },
      transactions: {
        create: {
          provider: PaymentProvider.STRIPE,
          providerTransactionId: 'pi_test_seed_alex_pi_01',
          status: 'SUCCEEDED',
          amountInCents: vipTier.priceInCents * 2,
          currency: 'USD',
          rawResponse: { stripeStatus: 'succeeded', test: true },
        },
      },
    },
  });

  console.log(`✅ Seeded sample order ${order.orderNumber} with 2 tickets (1 Issued, 1 Checked In)`);
  console.log('🎉 Outside.vip seed completed successfully.');
}

main()
  .catch((e) => {
    console.error('❌ Error seeding database:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
