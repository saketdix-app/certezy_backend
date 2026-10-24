// src/modules/categories/categories.controller.js

import * as service from './categories.service.js'
import { success } from '../../utils/response.js'

const getAllCategories = async (req, res, next) => {
  try {
    const categories = await service.getAllCategories()
    return success(res, { message: 'Categories fetched', data: { categories } })
  } catch (err) {
    next(err)
  }
}

const getCategoryById = async (req, res, next) => {
  try {
    const category = await service.getCategoryById(req.params.id)
    return success(res, { message: 'Category fetched', data: { category } })
  } catch (err) {
    next(err)
  }
}

const getCategoryBySlug = async (req, res, next) => {
  try {
    const category = await service.getCategoryBySlug(req.params.slug)
    return success(res, { message: 'Category fetched', data: { category } })
  } catch (err) {
    next(err)
  }
}

const createCategory = async (req, res, next) => {
  try {
    const category = await service.createCategory(req.body)
    return success(res, { statusCode: 201, message: 'Category created', data: { category } })
  } catch (err) {
    next(err)
  }
}

const updateCategory = async (req, res, next) => {
  try {
    const category = await service.updateCategory(req.params.id, req.body)
    return success(res, { message: 'Category updated', data: { category } })
  } catch (err) {
    next(err)
  }
}

const deleteCategory = async (req, res, next) => {
  try {
    await service.deleteCategory(req.params.id)
    return success(res, { message: 'Category deleted' })
  } catch (err) {
    next(err)
  }
}

export {
  getAllCategories,
  getCategoryById,
  getCategoryBySlug,
  createCategory,
  updateCategory,
  deleteCategory,
}
