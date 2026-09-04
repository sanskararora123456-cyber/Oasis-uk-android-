"use strict";
/* An example, and the shape every change follows.

   This one tidies phone numbers on customers and suppliers: strips spaces,
   dashes and brackets, and drops a +91 or leading 0 so every number is stored
   the same way. That is the kind of change that is easy to get wrong by hand
   across a few thousand records, and impossible to undo afterwards without
   something like this.

   Try it first — this writes nothing:

     node bin/oasis-admin.js change plan  --workspace OASIS --id EXAMPLE-2026-10-tidy-phone-numbers

   Then, if the sample diffs look right:

     node bin/oasis-admin.js change apply --workspace OASIS --id EXAMPLE-2026-10-tidy-phone-numbers --confirm

   And if it turns out to have been a bad idea:

     node bin/oasis-admin.js change undo  --workspace OASIS --id EXAMPLE-2026-10-tidy-phone-numbers --confirm

   Rename a copy of this file, change the three parts below, and that is a new
   change. Keep the id and the filename the same as each other: the id is what
   is written into the history, and it is how `undo` finds what to put back. */

const tidy = (value) => {
  const digits = String(value || "").replace(/[^\d]/g, "");
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
  return digits;
};

module.exports = {
  /* Must match the filename. Written into every affected record's history. */
  id: "EXAMPLE-2026-10-tidy-phone-numbers",

  /* Said back to you before anything happens, and written to the activity log. */
  description: "Store every phone number as plain digits, without +91 or a leading 0",

  /* Which collection: parties, products, docs, payments, expenses, branches… */
  field: "parties",

  /* Optional. Which records to consider — keep it narrow. Left out, every
     record in the collection is passed to apply. */
  select: (record) => {
    const phone = String(record.phone || "");
    return phone !== "" && phone !== tidy(phone);
  },

  /* What the record becomes. Return a new object; return null or the record
     unchanged to leave it alone. Never change the argument in place, and never
     drop fields you did not mean to touch — spread the original first.

     Anything not returned here is not written: a record is replaced wholesale
     by what comes back, so `{ ...record }` is how it keeps everything else. */
  apply: (record) => ({ ...record, phone: tidy(record.phone) }),
};
