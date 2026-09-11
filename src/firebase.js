import { initializeApp } from 'firebase/app'
import { getAuth, GoogleAuthProvider } from 'firebase/auth'
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager
} from 'firebase/firestore'

const firebaseConfig = {
  apiKey: 'AIzaSyAShWpFIMY8SCKlb9f_YJJLa2jiO9SZz4g',
  authDomain: 'tripplanner-94835.firebaseapp.com',
  projectId: 'tripplanner-94835',
  storageBucket: 'tripplanner-94835.firebasestorage.app',
  messagingSenderId: '284921342498',
  appId: '1:284921342498:web:44e872b8589733937f787b'
}

export const app = initializeApp(firebaseConfig)
export const auth = getAuth(app)
export const googleProvider = new GoogleAuthProvider()

export const db = initializeFirestore(app, {
  localCache: persistentLocalCache({
    tabManager: persistentMultipleTabManager()
  })
})
