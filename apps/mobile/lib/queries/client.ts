import { QueryClient } from '@tanstack/react-query'
import { shouldRetry } from './recipients'

// A module singleton, for the same reason `api` is one (lib/api.ts): a client
// recreated on remount throws away the cache and re-races every in-flight
// request. Creating it inside a component with useState would be the idiomatic
// React answer, but this app has one process-lifetime client and no server
// rendering, so the simpler thing is also the correct one here.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: shouldRetry,

      // Recipients change rarely and the user is paying for the request on
      // cellular. A minute is long enough that navigating away and back is
      // free, short enough that a stale list self-corrects without a manual
      // pull-to-refresh.
      staleTime: 60_000,

      // refetchOnWindowFocus is deliberately left at its default: there is no
      // window to focus in React Native, so it does nothing until something
      // wires it to AppState. M7's tracker is where a focus-refetch story
      // actually earns its keep — doing it here would be an untested code
      // path serving no screen.
    },
  },
})
