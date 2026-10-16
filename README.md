# Alfen Material Tracking

Site material management for Alfen Exclusive Doors & Windows. Tracks aluminium doors and windows against a job number (`JO0XXXXX`) through three stages, with photos at each one:

1. Booked from factory (driver, vehicle, date and time, material list, loading photos)
2. Received at site (receiver or driver, unloading team, problem items ticked, photos)
3. Verified by the fitting team (item-by-item check before opening, photos)

Roles: Admin, Manager, Store in charge, User (site receiver, driver, fitting team, job viewer).

`alfen-site-material.html` is the complete app. It currently stores data and photos using claude.ai's built-in storage, so it runs only when opened from claude.ai. A self-hosted version needs a server backend in place of that storage.
