# Cleanup requires proof of Prtisan ownership

Cleanup removes only idle resources identified by Prtisan-controlled paths,
registrations, and Docker ownership labels, revalidating each candidate before
deletion. Active, dirty, unreadable, shared, external, and legacy-unlabelled
resources are preserved and reported; there is no force mode. This deliberately
reclaims less space than Docker system pruning in exchange for never treating
unrelated developer data or unpublished agent work as disposable.

The Worker retains each preview behind a short-lived, one-use authorization.
Execution accepts only that authorization and reviewed candidate identifiers,
regenerates current ownership evidence, and removes the intersection. It never
accepts deletion targets or ownership claims from a client.
