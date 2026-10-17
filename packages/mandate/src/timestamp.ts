// The one timestamp rule (ADR 0020): ISO 8601 with seconds and an offset, on a real calendar
// date. Without an offset the day would depend on the server's zone, and date parsing would roll
// 31 Feb over to 3 Mar.

import { z } from "zod";

export const TimestampSchema = z.iso.datetime({ offset: true });
