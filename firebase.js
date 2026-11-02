import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import { initializeFirestore } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';

const firebaseConfig = {
  apiKey: 'AIzaSyDxIK0dmcxmAcxJnD6uL2vJkFUZ-peDH7U',
  authDomain: 'liveevent-7c956.firebaseapp.com',
  projectId: 'liveevent-7c956',
  storageBucket: 'liveevent-7c956.firebasestorage.app',
  messagingSenderId: '1062731967722',
  appId: '1:1062731967722:web:1ae750075746943d56fb93'
};

const app = initializeApp(firebaseConfig);

export const db = initializeFirestore(app, { experimentalAutoDetectLongPolling: true });
export const auth = getAuth(app);

export {
  collection,
  doc,
  getDoc,
  setDoc,
  deleteDoc,
  onSnapshot,
  query,
  orderBy,
  limit,
  serverTimestamp,
  writeBatch
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

export {
  signInAnonymously,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
