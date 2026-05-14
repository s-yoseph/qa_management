// Copyright (c) 2026, MMCY and contributors
// For license information, please see license.txt

frappe.ui.form.on("QA Checklist Template", {
	refresh(frm) {
		if (frm.__module_list_loaded) return;
		frm.__module_list_loaded = true;

		frappe.call({
			method: "frappe.client.get_list",
			args: {
				doctype: "Module Def",
				fields: ["name"],
				order_by: "name asc",
				limit_page_length: 0,
			},
			callback: function (r) {
				if (!r || !r.message) return;
				const modules = r.message.map((m) => m.name);

				// If the doctype already has a `module` field of type Select, populate its options
				const df = frm.meta.fields.find((f) => f.fieldname === "module");
				if (df) {
					if (df.fieldtype === "Select") {
						frm.set_df_property("module", "options", [""].concat(modules).join("\n"));
					} else if (df.fieldtype === "Link" && df.options === "Module Def") {
						// Link to Module Def - nothing to do, autocomplete works out of the box
					} else {
						// For other field types, provide a helper button to choose module
						add_module_picker_button(frm, modules);
					}
				} else {
					// If there's no module field, add a helper button so users can choose and we'll
					// attempt to set a `module` value if/when such a field exists or the form is extended.
					add_module_picker_button(frm, modules);
				}
			},
		});
	},
});

function add_module_picker_button(frm, modules) {
	// Avoid adding duplicate buttons
	if (frm.__module_picker_added) return;
	frm.__module_picker_added = true;

	frm.add_custom_button(__("Select Module"), function () {
		const d = new frappe.ui.Dialog({
			title: __("Select Module"),
			fields: [
				{
					fieldname: "module_select",
					label: __("Module"),
					fieldtype: "Select",
					options: modules.join("\n"),
				},
			],
			primary_action_label: __("Set"),
			primary_action(values) {
				if (!values || !values.module_select) {
					frappe.msgprint(__("Please select a module"));
					return;
				}
				// Try to set the standard `module` field if present
				if (frm.doc.hasOwnProperty("module")) {
					frm.set_value("module", values.module_select);
				} else {
					frappe.msgprint(
						__("Module chosen: {0}. Add a `module` field to the DocType to persist.", [
							values.module_select,
						]),
					);
				}
				d.hide();
			},
		});

		d.show();
	});
}

// Auto-generate test_case_id for new template items using template name, date, and sequence
frappe.ui.form.on("QA Checklist Template", "template_items_add", function (frm, cdt, cdn) {
	// run after the row is actually created and the grid has rendered
	setTimeout(function () {
		const row = locals[cdt] && locals[cdt][cdn];
		if (!row) return;
		console.debug("template_items_add fired", frm.doc.template_name, cdt, cdn);
		if (!row.test_case_id || row.test_case_id.toString().trim().toLowerCase() === "new") {
			// derive a stable prefix from the template name (use uppercase, dashes)
			let tpl = (frm.doc.template_name || "TEMPLATE").toString().trim();
			tpl = tpl.replace(/\s+/g, "-").toUpperCase();

			// find numeric suffixes for existing template items that use the same prefix
			const existing = (frm.doc.template_items || [])
				.map((r) => {
					if (!r || !r.test_case_id) return null;
					const m = r.test_case_id
						.toString()
						.match(
							new RegExp(
								"^" + tpl.replace(/[-\\/\\^$*+?.()|[\]{}]/g, "\\$&") + "-(\\d+)$",
							),
						);
					return m ? parseInt(m[1], 10) : null;
				})
				.filter((n) => Number.isFinite(n));

			const maxExisting = existing.length ? Math.max.apply(null, existing) : 0;
			const next = maxExisting + 1;
			const seq = String(next).padStart(3, "0");

			// set prefixed id so checklists that load this template can continue numbering
			frappe.model.set_value(cdt, cdn, "test_case_id", `${tpl}-${seq}`);

			// ensure grid UI refreshes for the specific child table
			try {
				const grid =
					frm.get_field("template_items") && frm.get_field("template_items").grid;
				if (grid) {
					grid.refresh();
				} else {
					frm.refresh_field("template_items");
				}
			} catch (e) {
				frm.refresh_field("template_items");
			}
		}
	}, 50);
});

// If user edits a template item `test_case_id` and sets it to 'new' (or clears it), auto-fill
frappe.ui.form.on("QA Checklist Template Item", "test_case_id", function (frm, cdt, cdn) {
	const row = locals[cdt][cdn];
	if (!row) return;
	const val = (row.test_case_id || "").toString().trim();
	if (!val || val.toLowerCase() === "new") {
		let tpl = (frm.doc.template_name || "TEMPLATE").toString().trim();
		tpl = tpl.replace(/\s+/g, "-").toUpperCase();

		const existing = (frm.doc.template_items || [])
			.map((r) => {
				if (!r || !r.test_case_id) return null;
				const m = r.test_case_id
					.toString()
					.match(
						new RegExp(
							"^" + str.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&") + "-(\\d+)$",
						),
					);
				return m ? parseInt(m[1], 10) : null;
			})
			.filter((n) => Number.isFinite(n));

		const maxExisting = existing.length ? Math.max.apply(null, existing) : 0;
		const next = maxExisting + 1;
		const seq = String(next).padStart(3, "0");
		frappe.model.set_value(cdt, cdn, "test_case_id", `${tpl}-${seq}`);
		frm.refresh_field("template_items");
	}
});

// On save, ensure any placeholder or empty ids for this template are normalized to PREFIX-###
frappe.ui.form.on("QA Checklist Template", "validate", function (frm) {
	const tpl = (frm.doc.template_name || "TEMPLATE")
		.toString()
		.trim()
		.replace(/\s+/g, "-")
		.toUpperCase();

	// collect existing numeric suffixes for this prefix
	const existing = (frm.doc.template_items || [])
		.map((r) => {
			if (!r || !r.test_case_id) return null;
			const m = r.test_case_id
				.toString()
				.match(
					new RegExp("^" + tpl.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&") + "-(\\d+)$"),
				);
			return m ? parseInt(m[1], 10) : null;
		})
		.filter((n) => Number.isFinite(n));

	let next = existing.length ? Math.max.apply(null, existing) + 1 : 1;

	(frm.doc.template_items || []).forEach((r) => {
		if (!r) return;
		const val = (r.test_case_id || "").toString().trim();
		const matchesPrefix = !!val.match(
			new RegExp("^" + tpl.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&") + "-(\\d+)$"),
		);
		if (!val || val.toLowerCase() === "new" || !matchesPrefix) {
			const seq = String(next).padStart(3, "0");
			frappe.model.set_value(r.doctype, r.name, "test_case_id", `${tpl}-${seq}`);
			next++;
		}
	});
});
