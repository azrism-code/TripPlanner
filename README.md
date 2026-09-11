# TripPlanner

TripPlanner is a standalone multi-user PWA for planning and managing personal trips.

## Stack

- React + Vite
- Firebase Authentication (Google + Email/Password)
- Cloud Firestore
- Firestore persistent offline cache
- Firebase Hosting
- PWA service worker via `vite-plugin-pwa`

## Security model

- Every authenticated user has a document at `users/{uid}`.
- Every trip has an `ownerId` matching its user.
- Firestore rules restrict normal users to their own profile and trips.
- Users with `role: "admin"` can access all users and trips.
- New accounts are always created with `role: "user"`; the first admin is promoted manually in Firebase Console after first sign-in.

## Local development

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

## Firebase

Project ID: `tripplanner-94835`

Deploy Firestore rules and Hosting with Firebase CLI after the project is connected:

```bash
firebase deploy --only firestore:rules,hosting
```

The repository and application are independent from the Japan Trip project.
