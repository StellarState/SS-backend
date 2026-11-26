# Waitlist queue

Pending entries are ordered by referral count descending, then signup time
ascending, then entry ID ascending. Referral count is the priority signal;
signup time and ID provide stable tie-breaking. Public positions are one-based
ordinals in this queue, so only pending entries have a position. Approved
entries return `position: null`.

The admin queue and bulk approval use the same ordering as public positions.
