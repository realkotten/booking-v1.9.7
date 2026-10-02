import { initializeApp } from 'firebase/app';
import { DEFAULT_CLIENT_AVATAR } from './data/avatars';
import { 
  getAuth, 
  GoogleAuthProvider, 
  OAuthProvider,
  RecaptchaVerifier,
  signInWithPhoneNumber,
  ConfirmationResult,
  signInWithPopup, 
  signInWithEmailAndPassword, 
  createUserWithEmailAndPassword, 
  signOut, 
  onAuthStateChanged, 
  updateProfile,
  sendPasswordResetEmail,
  User as FirebaseUser 
} from 'firebase/auth';
import { 
  initializeFirestore,
  doc, 
  getDoc, 
  getDocFromServer,
  setDoc, 
  updateDoc, 
  deleteDoc,
  serverTimestamp,
  collection,
  onSnapshot
} from 'firebase/firestore';
import type { Appointment, Reservation } from './types';
import firebaseConfig from '../firebase-applet-config.json';

// Initialize Firebase App
export const app = initializeApp(firebaseConfig);

// Initialize Firestore with specific database ID and robust long-polling transport for web/iframe
export const db = initializeFirestore(app, {
  experimentalForceLongPolling: true,
  ignoreUndefinedProperties: true
}, firebaseConfig.firestoreDatabaseId);

// Initialize Firebase Auth
export const auth = getAuth(app);

// Configure Google Auth Provider
export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({
  prompt: 'select_account'
});

// Configure Apple Auth Provider
export const appleProvider = new OAuthProvider('apple.com');
appleProvider.addScope('email');
appleProvider.addScope('name');

// Export Phone Auth helpers
export { RecaptchaVerifier, signInWithPhoneNumber };
export type { ConfirmationResult };

/**
 * Safely clear any existing RecaptchaVerifier instance and DOM contents
 */
export function clearPhoneRecaptcha(containerId = 'phone-recaptcha-container'): void {
  if (typeof window === 'undefined') return;
  try {
    if ((window as any).recaptchaVerifier) {
      try {
        (window as any).recaptchaVerifier.clear();
      } catch (e) {}
      (window as any).recaptchaVerifier = null;
    }
  } catch (e) {
    (window as any).recaptchaVerifier = null;
  }

  // Ensure DOM container is emptied and reset cleanly to avoid "reCAPTCHA has already been rendered"
  try {
    const el = document.getElementById(containerId);
    if (el && el.parentNode) {
      const freshEl = document.createElement('div');
      freshEl.id = containerId;
      freshEl.className = el.className;
      el.parentNode.replaceChild(freshEl, el);
    }
  } catch (e) {}
}

/**
 * Initialize invisible RecaptchaVerifier for Phone Authentication
 */
export function getOrCreatePhoneRecaptcha(containerId = 'phone-recaptcha-container', isInvisible = true): RecaptchaVerifier {
  if (typeof window === 'undefined') return null as any;

  // Clear previous verifier and reset container DOM node
  clearPhoneRecaptcha(containerId);

  let containerEl = document.getElementById(containerId);
  if (!containerEl) {
    containerEl = document.createElement('div');
    containerEl.id = containerId;
    document.body.appendChild(containerEl);
  }

  const verifier = new RecaptchaVerifier(auth, containerId, {
    size: isInvisible ? 'invisible' : 'normal',
    callback: () => {
      // reCAPTCHA solved silently
    },
    'expired-callback': () => {
      console.warn('reCAPTCHA expired.');
      clearPhoneRecaptcha(containerId);
    }
  });

  (window as any).recaptchaVerifier = verifier;
  return verifier;
}

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData?.map(provider => ({
        providerId: provider.providerId,
        email: provider.email,
      })) || []
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// Test Connection on boot
export async function testConnection() {
  try {
    const testDoc = await getDocFromServer(doc(db, 'test', 'connection'));
    return testDoc.exists();
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error("Please check your Firebase configuration.");
    }
    return false;
  }
}
if (typeof window !== 'undefined') {
  testConnection();
}

// User profile helper to save/sync Firestore profile
export async function syncUserProfile(user: FirebaseUser, extraData?: { phoneNumber?: string; formulaNotes?: string; displayName?: string }) {
  if (!user || !user.uid) return null;
  
  const userRef = doc(db, 'users', user.uid);
  try {
    const existingSnap = await getDoc(userRef);
    const existingData = existingSnap.exists() ? existingSnap.data() : null;

    const profileData = {
      id: user.uid,
      email: user.email || '',
      displayName: extraData?.displayName || user.displayName || existingData?.displayName || '',
      photoURL: user.photoURL || existingData?.photoURL || DEFAULT_CLIENT_AVATAR,
      phoneNumber: extraData?.phoneNumber || existingData?.phoneNumber || user.phoneNumber || '',
      formulaNotes: extraData?.formulaNotes || existingData?.formulaNotes || '',
      role: (['heiskottensbro@gmail.com', 'astrologistkotten@gmail.com', 'speakerkot10@gmail.com'].includes(user.email || '') || existingData?.role === 'admin') ? 'admin' : 'client',
      updatedAt: new Date().toISOString(),
      ...(existingSnap.exists() ? {} : { createdAt: new Date().toISOString() })
    };

    await setDoc(userRef, profileData, { merge: true });
    return profileData;
  } catch (err) {
    console.warn('Could not sync user profile to Firestore (using local fallback):', err);
    return null;
  }
}

/**
 * Sync appointment to Firestore cloud database with complete attribute validation
 */
export async function syncAppointmentToFirestore(appointment: Appointment): Promise<boolean> {
  if (!appointment || !appointment.id) return false;
  const aptRef = doc(db, 'appointments', appointment.id);

  try {
    const payload: Record<string, any> = {
      id: appointment.id,
      customerName: appointment.customerName || 'مشتری گرامی',
      serviceName: appointment.service?.name || (appointment as any).serviceName || 'اصلاح مو و پیرایش',
      status: appointment.status || 'confirmed',
      appointmentNumber: appointment.appointmentNumber || '',
      customerId: appointment.customerId || '',
      customerPhone: appointment.customerPhone || '',
      serviceId: appointment.serviceId || appointment.service?.id || '',
      servicePrice: Number(appointment.servicePrice || appointment.service?.price || 0),
      totalAmount: Number(appointment.totalAmount || 0),
      depositAmount: Number(appointment.depositAmount || 0),
      date: appointment.date || '',
      dayNumber: Number(appointment.dayNumber || 1),
      startTime: appointment.startTime || '',
      endTime: appointment.endTime || '',
      durationMinutes: Number(appointment.durationMinutes || 45),
      barberId: appointment.barberId || '',
      barberName: appointment.barberName || '',
      chairId: appointment.chairId || '',
      chairName: appointment.chairName || '',
      notes: appointment.customerNotes || appointment.stylingNotes || '',
      customerNotes: appointment.customerNotes || '',
      stylingNotes: appointment.stylingNotes || '',
      isQuietSession: Boolean(appointment.isQuietSession),
      isVip: Boolean(appointment.isVip),
      bookingSource: appointment.bookingSource || 'online',
      createdAt: appointment.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Attach userId only if authenticated
    if (auth.currentUser?.uid) {
      payload.userId = auth.currentUser.uid;
    }

    if (appointment.service) {
      payload.service = {
        id: appointment.service.id,
        name: appointment.service.name,
        price: Number(appointment.service.price || 0),
        durationMinutes: Number(appointment.service.durationMinutes || 45),
        description: appointment.service.description || '',
      };
    }

    if (appointment.additionalAccoutrements && appointment.additionalAccoutrements.length > 0) {
      payload.additionalAccoutrements = appointment.additionalAccoutrements;
    }

    if (appointment.beverage) {
      payload.beverage = appointment.beverage;
    }

    await setDoc(aptRef, payload, { merge: true });
    return true;
  } catch (err) {
    console.warn('Could not sync appointment to Firestore:', err);
    return false;
  }
}

/**
 * Sync reservation to Firestore 'bookings' collection with full data persistence as source of truth.
 */
export async function syncBookingToFirestore(reservation: Reservation): Promise<boolean> {
  if (!reservation || !reservation.id) return false;
  const bookingRef = doc(db, 'bookings', reservation.id);

  try {
    const payload: Record<string, any> = {
      id: reservation.id,
      customerName: reservation.customerName || 'مشتری گرامی',
      serviceName: reservation.service?.name || (reservation as any).serviceName || 'سرویس آرایشگاه رویال',
      status: reservation.status || 'confirmed',
      reservationNumber: reservation.reservationNumber || reservation.appointmentNumber || reservation.id,
      appointmentNumber: reservation.appointmentNumber || reservation.reservationNumber || '',
      customerId: reservation.customerId || '',
      customerPhone: reservation.customerPhone || '',
      serviceId: reservation.serviceId || reservation.service?.id || '',
      servicePrice: Number(reservation.servicePrice || reservation.service?.price || 0),
      totalAmount: Number(reservation.totalAmount || 0),
      depositAmount: Number(reservation.depositAmount || 0),
      date: reservation.date || reservation.selectedDate || '',
      selectedDate: reservation.selectedDate || reservation.date || '',
      startTime: reservation.startTime || reservation.selectedTime || '',
      selectedTime: reservation.selectedTime || reservation.startTime || '',
      endTime: reservation.endTime || '',
      durationMinutes: Number(reservation.durationMinutes || 45),
      barberId: reservation.barberId || '',
      barberName: reservation.barberName || reservation.artisan || '',
      artisan: reservation.artisan || reservation.barberName || '',
      chairId: reservation.chairId || '',
      chairName: reservation.chairName || reservation.suite || '',
      suite: reservation.suite || reservation.chairName || '',
      location: reservation.location || 'آرایشگاه رویال',
      notes: reservation.customerNotes || reservation.stylingNotes || '',
      customerNotes: reservation.customerNotes || '',
      stylingNotes: reservation.stylingNotes || '',
      isQuietSession: Boolean(reservation.isQuietSession),
      isVip: Boolean(reservation.isVip),
      bookingSource: reservation.bookingSource || 'online',
      createdAt: reservation.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    if (auth.currentUser?.uid) {
      payload.userId = auth.currentUser.uid;
    }

    if (reservation.service) {
      payload.service = {
        id: reservation.service.id,
        name: reservation.service.name,
        price: Number(reservation.service.price || 0),
        durationMinutes: Number(reservation.service.durationMinutes || 45),
        description: reservation.service.description || '',
      };
    }

    if (reservation.additionalAccoutrements && reservation.additionalAccoutrements.length > 0) {
      payload.additionalAccoutrements = reservation.additionalAccoutrements;
    }

    if (reservation.beverage) {
      payload.beverage = reservation.beverage;
    }

    if (reservation.priceSummary) {
      payload.priceSummary = {
        total: Number(reservation.priceSummary.total || 0),
        originalTotal: Number(reservation.priceSummary.originalTotal || 0),
        discountAmount: Number(reservation.priceSummary.discountAmount || 0),
        hasDiscount: Boolean(reservation.priceSummary.hasDiscount),
        lines: Array.isArray(reservation.priceSummary.lines) ? reservation.priceSummary.lines : []
      };
    }

    await setDoc(bookingRef, payload, { merge: true });
    return true;
  } catch (err: any) {
    console.warn('Could not sync current reservation to Firestore bookings collection:', err);
    if (err?.code === 'permission-denied') {
      try {
        handleFirestoreError(err, OperationType.WRITE, `bookings/${reservation.id}`);
      } catch (fatal) {
        throw fatal;
      }
    }
    return false;
  }
}

/**
 * Fetch a specific booking from Firestore 'bookings' collection
 */
export async function fetchBookingFromFirestore(bookingId: string): Promise<Reservation | null> {
  if (!bookingId) return null;
  try {
    const bookingRef = doc(db, 'bookings', bookingId);
    const snap = await getDoc(bookingRef);
    if (snap.exists()) {
      return snap.data() as Reservation;
    }
    return null;
  } catch (err: any) {
    console.warn('Could not fetch booking from Firestore:', err);
    return null;
  }
}

/**
 * Subscribe to real-time updates for an active booking in 'bookings' collection,
 * ensuring Firestore persistence acts as the continuous source of truth.
 */
export function subscribeToBookingInFirestore(
  bookingId: string,
  onUpdate: (booking: Reservation) => void,
  onError?: (err: any) => void
): () => void {
  if (!bookingId) return () => {};
  try {
    const bookingRef = doc(db, 'bookings', bookingId);
    const unsubscribe = onSnapshot(
      bookingRef,
      (docSnap) => {
        if (docSnap.exists()) {
          const data = docSnap.data() as Reservation;
          if (data && data.id) {
            onUpdate(data);
          }
        }
      },
      (error) => {
        console.warn('Firestore booking subscription error:', error.message);
        if (onError) onError(error);
      }
    );
    return unsubscribe;
  } catch (err) {
    console.warn('Could not subscribe to Firestore booking:', err);
    return () => {};
  }
}

/**
 * Update booking status in 'bookings' collection
 */
export async function updateBookingStatusInFirestore(
  bookingId: string,
  status: Reservation['status']
): Promise<boolean> {
  if (!bookingId) return false;
  try {
    const bookingRef = doc(db, 'bookings', bookingId);
    await updateDoc(bookingRef, {
      status,
      updatedAt: new Date().toISOString(),
    });
    return true;
  } catch (err) {
    console.warn('Could not update booking status in Firestore bookings:', err);
    return false;
  }
}

/**
 * Real-time cloud subscription to appointments in Firestore
 * Updates across all devices (client phone, barber phone, admin console) instantly
 */
export function subscribeToFirestoreAppointments(
  onUpdate: (appointments: Appointment[]) => void
): () => void {
  try {
    const colRef = collection(db, 'appointments');
    const unsubscribe = onSnapshot(
      colRef,
      (snapshot) => {
        const items: Appointment[] = [];
        snapshot.forEach((docSnap) => {
          const data = docSnap.data();
          if (data && data.id) {
            items.push(data as Appointment);
          }
        });
        // Sort newest first
        items.sort((a, b) => {
          const timeA = new Date(a.createdAt || 0).getTime();
          const timeB = new Date(b.createdAt || 0).getTime();
          return timeB - timeA;
        });
        if (items.length > 0) {
          onUpdate(items);
        }
      },
      (error) => {
        console.warn('Firestore appointments onSnapshot notice:', error.message);
      }
    );
    return unsubscribe;
  } catch (err) {
    console.warn('Could not subscribe to Firestore appointments:', err);
    return () => {};
  }
}

/**
 * Update appointment status in Firestore
 */
export async function updateAppointmentStatusInFirestore(
  appointmentId: string,
  status: Appointment['status']
): Promise<boolean> {
  if (!appointmentId) return false;
  try {
    const aptRef = doc(db, 'appointments', appointmentId);
    await updateDoc(aptRef, {
      status,
      updatedAt: new Date().toISOString(),
    });
    return true;
  } catch (err) {
    console.warn('Could not update appointment status in Firestore:', err);
    return false;
  }
}

/**
 * Delete appointment from Firestore
 */
export async function deleteAppointmentFromFirestore(appointmentId: string): Promise<boolean> {
  if (!appointmentId) return false;
  try {
    const aptRef = doc(db, 'appointments', appointmentId);
    await deleteDoc(aptRef);
    return true;
  } catch (err) {
    console.warn('Could not delete appointment from Firestore:', err);
    return false;
  }
}

export {
  signInWithPopup,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  updateProfile,
  sendPasswordResetEmail,
  type FirebaseUser
};
