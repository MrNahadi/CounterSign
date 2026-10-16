# Avatar

A round picture or initials for a person or workspace, in 20, 24, 32 or 40px, and stacked groups that overlap with a mask cutout.

## What you provide

- `<span class="gr-avatar gr-avatar-32">` holding an `<img alt="">` or one or two initials.
- For initials, a hue class picked from the user's ID: `gr-avatar-blue`, `-green`, `-orange` or `-tomato`. Each pairs step 3 alpha fill with step 11 text.
- Groups: `gr-avatar-group` around the avatars, ending with a neutral avatar holding the overflow count ("+5").

## Rules

- Group members overlap by 20% of their size. The cutout is a mask, not a colored ring, so it works on any background.
- Show at most four faces in a group before the count.
- Give each avatar an accessible name through the image alt or `aria-label` when it isn't next to the name in text.
