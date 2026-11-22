Changed

- Development: a run of the API's integration or smoke tests creates one throwaway Keycloak realm for the whole run instead of one per test file (`#639`), and each file gets users of its own in it; the realm is deleted when the run ends, also when it is interrupted, and the next run sweeps the realms a killed run left behind. `apps/api/README.md`, "One Keycloak realm per run", has the details. With three files at a time, the integration run went from 182 s to 117 s and the smoke run from 41 s to 25 s.
