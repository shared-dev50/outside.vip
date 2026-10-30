import PDFDocument from 'pdfkit';
import QRCode from 'qrcode';


interface TicketPdfEvent {
  title: string;
  tagline?: string | null;
  description?: string | null;
  category: string;
  coverImageUrl?: string | null;
  venueName?: string | null;
  venueAddress?: string | null;
  city?: string | null;
  country?: string | null;
  startAt: Date | string;
  endAt?: Date | string | null;
  timezone?: string | null;
  ageRestriction?: string | null;
  organizer?: {
    name?: string | null;
    organizer?: {
      displayName?: string | null;
    } | null;
  } | null;
}

interface TicketPdfItem {
  id: string;
  ticketToken: string;
  attendeeName?: string | null;
  attendeeEmail?: string | null;
  ticketTier?: {
    id: string;
    name: string;
    description?: string | null;
    priceInCents: number;
    currency?: string | null;
  } | null;
}

interface TicketPdfOrder {
  orderNumber: string;
  createdAt: Date | string;
  customerName: string;
  customerEmail: string;
  event: TicketPdfEvent;
  tickets: TicketPdfItem[];
}

/**
 * Format event date range matching the ticket reference:
 * e.g. "Sat, Nov 21, 2026, 10:00 PM – Sun, Nov 22, 2026, 2:00 AM"
 */
function formatEventDateRange(start: Date | string, end?: Date | string | null, timezone = 'Africa/Nairobi'): string {
  try {
    const startDate = new Date(start);
    const startStr = new Intl.DateTimeFormat('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: timezone || 'Africa/Nairobi',
    }).format(startDate);

    if (!end) return startStr;

    const endDate = new Date(end);
    const endStr = new Intl.DateTimeFormat('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: timezone || 'Africa/Nairobi',
    }).format(endDate);

    return `${startStr} – ${endStr}`;
  } catch {
    return new Date(start).toLocaleString();
  }
}

/**
 * Format order creation date matching the reference:
 * e.g. "Thu, Oct 15, 2026, 11:36 PM"
 */
function formatOrderDate(date: Date | string): string {
  try {
    const d = new Date(date);
    return new Intl.DateTimeFormat('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(d);
  } catch {
    return new Date(date).toLocaleString();
  }
}

async function fetchImageBuffer(url?: string | null, timeoutMs = 3500): Promise<Buffer | null> {
  if (!url || !url.startsWith('http')) return null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return null;
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch {
    return null;
  }
}

async function generateQrBuffer(token: string): Promise<Buffer> {
  return QRCode.toBuffer(token, {
    type: 'png',
    margin: 1,
    errorCorrectionLevel: 'M',
    width: 320,
    color: {
      dark: '#111827',
      light: '#FFFFFF',
    },
  });
}

export async function generateTicketsPdf(
  order: TicketPdfOrder,
  specificTicketId?: string
): Promise<Buffer> {
  const ticketsToRender = specificTicketId
    ? order.tickets.filter((t) => t.id === specificTicketId)
    : order.tickets;

  if (ticketsToRender.length === 0) {
    throw new Error('No tickets found for this order.');
  }

  // Pre-fetch cover image buffer once for all pages
  const coverImageBuffer = await fetchImageBuffer(order.event.coverImageUrl);

  return new Promise(async (resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'A4',
        margin: 32,
        info: {
          Title: `Outside.vip Passes - Order ${order.orderNumber}`,
          Author: 'Outside.vip',
          Subject: order.event.title,
        },
      });

      const chunks: Buffer[] = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', (err) => reject(err));

      const leftMargin = 32;
      const rightMargin = 595.28 - 32;
      const contentWidth = 531.28;
      const totalTickets = order.tickets.length;

      for (let i = 0; i < ticketsToRender.length; i++) {
        const ticket = ticketsToRender[i];
        const ticketIndex = order.tickets.findIndex((t) => t.id === ticket.id);
        const displayIndex = ticketIndex !== -1 ? ticketIndex + 1 : i + 1;

        if (i > 0) {
          doc.addPage();
        }

        let currentY = 32;

        const bannerHeight = 190;
        if (coverImageBuffer) {
          doc.save();
          doc.roundedRect(leftMargin, currentY, contentWidth, bannerHeight, 8).clip();
          try {
            doc.image(coverImageBuffer, leftMargin, currentY, {
              width: contentWidth,
              height: bannerHeight,
              cover: [contentWidth, bannerHeight],
              align: 'center',
              valign: 'center',
            });
          } catch {
            doc.roundedRect(leftMargin, currentY, contentWidth, bannerHeight, 8).fill('#111827');
            doc.fillColor('#FAF8F5').fontSize(20).font('Helvetica-Bold')
               .text(order.event.title, leftMargin + 20, currentY + 70, { width: contentWidth - 40, align: 'center' });
          }
          doc.restore();
        } else {
          doc.save();
          doc.roundedRect(leftMargin, currentY, contentWidth, bannerHeight, 8).fill('#111827');
          doc.fillColor('#FAF8F5').fontSize(20).font('Helvetica-Bold')
             .text(order.event.title, leftMargin + 20, currentY + 70, { width: contentWidth - 40, align: 'center' });
          doc.fillColor('#9CA3AF').fontSize(9).font('Helvetica')
             .text(`${(order.event.category || 'EVENT').toUpperCase()} · OUTSIDE.VIP`, leftMargin + 20, currentY + 105, { width: contentWidth - 40, align: 'center' });
          doc.restore();
        }

        currentY += bannerHeight + 14;

        const headerTopY = currentY;
        const col1Width = 285;
        const col2X = leftMargin + 295;
        const col2Width = contentWidth - 295;

        // Left: Event Title and Organizer
        doc.font('Helvetica-Bold').fontSize(14).fillColor('#111827')
           .text(order.event.title, leftMargin, headerTopY, { width: col1Width });

        const titleHeight = doc.heightOfString(order.event.title, { width: col1Width });
        const organizerName =
          order.event.organizer?.name ||
          order.event.organizer?.organizer?.displayName ||
          'Outside.vip Collective';

        doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#4B5563')
           .text(`By ${organizerName.toUpperCase()}`, leftMargin, headerTopY + titleHeight + 4, { width: col1Width });

        // Right: Ticket Validity and Address
        let rightHeaderY = headerTopY;
        doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#6B7280')
           .text('TICKET VALIDITY', col2X, rightHeaderY);
        rightHeaderY += 10;

        const validityText = formatEventDateRange(order.event.startAt, order.event.endAt, order.event.timezone || undefined);
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#1F2937')
           .text(validityText, col2X, rightHeaderY, { width: col2Width });
        rightHeaderY += doc.heightOfString(validityText, { width: col2Width }) + 6;

        doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#6B7280')
           .text('ADDRESS', col2X, rightHeaderY);
        rightHeaderY += 10;

        const addressParts = [
          order.event.venueName,
          order.event.venueAddress,
          order.event.city,
          order.event.country,
        ].filter(Boolean);
        const addressText = addressParts.join(', ') || 'Nairobi, Kenya';

        doc.font('Helvetica').fontSize(8.5).fillColor('#1F2937')
           .text(addressText, col2X, rightHeaderY, { width: col2Width });
        rightHeaderY += doc.heightOfString(addressText, { width: col2Width });

        currentY = Math.max(headerTopY + titleHeight + 24, rightHeaderY) + 12;

        doc.strokeColor('#E5E7EB').lineWidth(0.75)
           .moveTo(leftMargin, currentY)
           .lineTo(rightMargin, currentY)
           .stroke();

        currentY += 14;

        const bodyTopY = currentY;
        const bodyCol1Width = 300;
        const bodyCol2X = leftMargin + 318;
        const bodyCol2Width = 213;

        let leftColY = bodyTopY;
        const tierName = ticket.ticketTier?.name || 'General Admission Pass';
        doc.font('Helvetica-Bold').fontSize(13.5).fillColor('#111827')
           .text(tierName, leftMargin, leftColY, { width: bodyCol1Width });
        leftColY += 18;

        const desc = ticket.ticketTier?.description || order.event.description || order.event.tagline || '';
        if (desc) {
          // Truncate narrative cleanly if exceptionally long to prevent overlapping
          const cleanDesc = desc.length > 450 ? `${desc.slice(0, 447)}...` : desc;
          doc.font('Helvetica').fontSize(8.5).fillColor('#374151').lineGap(2)
             .text(cleanDesc, leftMargin, leftColY, { width: bodyCol1Width });
          leftColY += doc.heightOfString(cleanDesc, { width: bodyCol1Width, lineGap: 2 }) + 14;
        } else {
          leftColY += 8;
        }

        const priceCents = ticket.ticketTier?.priceInCents ?? 0;
        const formattedPrice = priceCents === 0 ? '$0.00 (Free)' : `$${(priceCents / 100).toFixed(2)}`;
        const shortToken = ticket.ticketToken.replace(/^tkt_sec_/, '').slice(0, 14);

        doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#111827')
           .text(`Ticket #${shortToken} – Price: ${formattedPrice}`, leftMargin, leftColY);
        leftColY += 13;

        doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#111827')
           .text(`Event date: ${validityText}`, leftMargin, leftColY, { width: bodyCol1Width });
        leftColY += doc.heightOfString(`Event date: ${validityText}`, { width: bodyCol1Width }) + 4;

        doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#111827')
           .text(`Order #${order.orderNumber} – ${formatOrderDate(order.createdAt)}`, leftMargin, leftColY);
        leftColY += 13;

        const attendee = ticket.attendeeName || order.customerName || 'Attendee';
        const email = ticket.attendeeEmail || order.customerEmail || '';
        doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#111827')
           .text(`Customer: ${attendee} <${email}>`, leftMargin, leftColY, { width: bodyCol1Width });

        let rightColY = bodyTopY;

        const noticeBoxHeight = 44;
        doc.save();
        doc.roundedRect(bodyCol2X, rightColY, bodyCol2Width, noticeBoxHeight, 6)
           .fillAndStroke('#F9FAFB', '#E5E7EB');

        doc.roundedRect(bodyCol2X + 8, rightColY + 8, 28, 28, 4).fill('#111827');
        doc.strokeColor('#FFFFFF').lineWidth(1.5)
           .moveTo(bodyCol2X + 16, rightColY + 22)
           .lineTo(bodyCol2X + 21, rightColY + 27)
           .lineTo(bodyCol2X + 29, rightColY + 17)
           .stroke();

        doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#111827')
           .text('Authentic pass verified by Outside.vip', bodyCol2X + 42, rightColY + 8, { width: bodyCol2Width - 48 });
        doc.font('Helvetica').fontSize(6.5).fillColor('#6B7280').lineGap(1)
           .text('Tickets acquired outside Outside.vip are not secure and do not guarantee entry.', bodyCol2X + 42, rightColY + 20, { width: bodyCol2Width - 48 });
        doc.restore();

        rightColY += noticeBoxHeight + 14;

        doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#111827')
           .text(`Ticket ${displayIndex} / ${totalTickets}`, bodyCol2X, rightColY, { width: bodyCol2Width, align: 'center' });
        rightColY += 15;

        const qrBuffer = await generateQrBuffer(ticket.ticketToken);
        const qrSize = 130;
        const qrX = bodyCol2X + (bodyCol2Width - qrSize) / 2;
        doc.image(qrBuffer, qrX, rightColY, { width: qrSize, height: qrSize });
        rightColY += qrSize + 6;

        doc.font('Helvetica-Bold').fontSize(8).fillColor('#1F2937')
           .text(ticket.ticketToken, bodyCol2X, rightColY, { width: bodyCol2Width, align: 'center' });
        rightColY += 14;

        const agePolicy = order.event.ageRestriction || '18+';
        doc.font('Helvetica').fontSize(6.5).fillColor('#6B7280')
           .text(`${agePolicy} W/ ID`, bodyCol2X, rightColY, { width: bodyCol2Width, align: 'center' });
        rightColY += 9;

        doc.font('Helvetica').fontSize(6.5).fillColor('#6B7280')
           .text('Tickets sold are non-refundable', bodyCol2X, rightColY, { width: bodyCol2Width, align: 'center' });

        const footerY = 780;
        doc.font('Helvetica-Bold').fontSize(11).fillColor('#111827')
           .text('OUTSIDE.VIP', leftMargin, footerY, { width: contentWidth, align: 'center', characterSpacing: 1.5 });

        doc.font('Helvetica').fontSize(6.5).fillColor('#6B7280')
           .text('Delivered by Outside.vip · Verified Secure Event Ticketing · tickets@outside.vip', leftMargin, footerY + 14, { width: contentWidth, align: 'center' });
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}
