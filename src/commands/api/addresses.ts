import { Command } from "commander"
import { defineResource } from "../../lib/resource"

export const addressesCommand = (): Command =>
  defineResource({
    name: "addresses",
    description: "Regulatory addresses for phone number compliance.",
    basePath: "/v1/addresses",
    itemKey: "address",
    idArg: "addressId",
    create: true,
    remove: true,
    format: (a) => ({
      id: a.id,
      country: a.countryCode,
      city: a.locality ?? "—",
      status: a.status,
    }),
  })
